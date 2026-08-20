/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Tree } from '@nx/devkit';
import { createTreeUsingTsSolutionSetup } from '../../../utils/test';
import migration from './migration';

const PY_MAIN_FILE = 'apps/agui-project/proj_test_project/agent/main.py';
const TS_INDEX_FILE = 'apps/agui-project/ts-project/my-agent/index.ts';

const BEFORE_PY = `import logging
import uuid
from contextlib import asynccontextmanager

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_strands import StrandsAgent, StrandsAgentConfig
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from proj_test_project.agent_connection import get_current_session_id, session_id_context
from starlette.middleware.base import BaseHTTPMiddleware

from .agent import get_agent
from .session import get_session_manager

logging.basicConfig(level=logging.INFO)

SESSION_ID_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id"


@asynccontextmanager
async def lifespan(app: FastAPI):
    with get_agent() as agent:
        app.state.agui_agent = StrandsAgent(
            agent=agent,
            name="MyAgent",
            description="A Strands Agent exposed via the AG-UI protocol.",
            config=StrandsAgentConfig(session_manager_provider=lambda _input_data: get_session_manager()),
        )
        yield


class _SessionIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        session_id = request.headers.get(SESSION_ID_HEADER) or str(uuid.uuid4())
        with session_id_context(session_id):
            return await call_next(request)


app = FastAPI(title="AWS Strands - MyAgent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(_SessionIdMiddleware)


@app.post("/invocations")
async def invocations(request: Request):
    encoder = EventEncoder(accept=request.headers.get("accept") or "")
    raw = await request.body()
    try:
        input_data = RunAgentInput.model_validate_json(raw)
    except Exception as exc:
        message = f"Invalid RunAgentInput: {str(exc)[:200]}"

        async def _bad():
            yield encoder.encode(RunErrorEvent(type=EventType.RUN_ERROR, message=message, code="BAD_REQUEST"))

        return StreamingResponse(_bad(), media_type=encoder.get_content_type())

    session_id = request.headers.get(SESSION_ID_HEADER) or get_current_session_id()

    async def event_generator():
        with session_id_context(session_id or str(uuid.uuid4())):
            async for event in request.app.state.agui_agent.run(input_data):
                try:
                    yield encoder.encode(event)
                except Exception as e:
                    error_event = RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=f"Encoding error: {e}",
                        code="ENCODING_ERROR",
                    )
                    yield encoder.encode(error_event)
                    break

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


@app.get("/ping")
async def ping():
    return {"status": "healthy"}
`;

const BEFORE_TS = `import { StrandsAgent } from '@ag-ui/aws-strands';
import {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
} from '@ag-ui/aws-strands/server';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import {
  ModelErrorLoggingPlugin,
  ToolErrorLoggingPlugin,
  runWithSessionId,
} from '@proj/agent-connection';
import { getAgent } from './agent.js';
import { getSessionManager } from './session.js';

const PORT = parseInt(process.env.PORT || '8080');
const HOST = '0.0.0.0';

const SESSION_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

// Bind the inbound session (or a fresh UUID) for downstream MCP / A2A calls.
const sessionIdMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers[SESSION_ID_HEADER];
  const sessionId = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
  runWithSessionId(sessionId, () => next());
};

void (async () => {
  const agent = await getAgent();

  await agent.initialize();

  const aguiAgent = new StrandsAgent({
    agent,
    name: 'MyAgent',
    description: 'A Strands Agent exposed via the AG-UI protocol.',
    plugins: [new ModelErrorLoggingPlugin(), new ToolErrorLoggingPlugin()],
    config: {
      sessionManagerProvider: getSessionManager,
    },
  });

  const app = express();
  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json({ limit: '50mb' }));

  addPing(app, '/ping');
  addCapabilities(app, '/capabilities', { agent: aguiAgent });

  app.use(sessionIdMiddleware);

  addStrandsExpressEndpoint(app, aguiAgent, { path: '/invocations' });

  app.listen(PORT, HOST, () => {
    console.log(\`AG-UI server listening on \${HOST}:\${PORT}\`);
  });
})();
`;

// A hand-customised middleware that no longer matches the generated shape.
const DIVERGED_TS = `import {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
} from '@ag-ui/aws-strands/server';
import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

const SESSION_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

const sessionIdMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers[SESSION_ID_HEADER];
  const sessionId = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
  console.log('custom logging added by hand');
  next();
};
`;

describe('agui-session-id-thread-id-mismatch migration', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('adds the mismatch check to a vended ag-ui main.py', async () => {
    tree.write(PY_MAIN_FILE, BEFORE_PY);

    const result = await migration(tree);

    const content = tree.read(PY_MAIN_FILE, 'utf-8') ?? '';
    expect(content).toContain(
      'if session_id != input_data.thread_id.ljust(33, "0"):',
    );
    expect(content).toContain('code="SESSION_ID_MISMATCH"');
    expect(result.nextSteps).toEqual([]);
  });

  it('adds the mismatch check to a vended ag-ui index.ts', async () => {
    tree.write(TS_INDEX_FILE, BEFORE_TS);

    const result = await migration(tree);

    const content = tree.read(TS_INDEX_FILE, 'utf-8') ?? '';
    expect(content).toContain(
      "import { EventType, type RunErrorEvent } from '@ag-ui/core';",
    );
    expect(content).toContain("import { EventEncoder } from '@ag-ui/encoder';");
    expect(content).toContain("sessionId !== threadId.padEnd(33, '0')");
    expect(content).toContain("code: 'SESSION_ID_MISMATCH'");
    // The `_res` param must become `res` now that it's used.
    expect(content).not.toContain('_res');
    expect(content).toContain('res: Response');
    expect(result.nextSteps).toEqual([]);
  });

  it('skips and reports a customised sessionIdMiddleware', async () => {
    tree.write(TS_INDEX_FILE, DIVERGED_TS);

    const result = await migration(tree);

    // formatFilesInSubtree still reformats whitespace, so assert on content
    // rather than exact equality — the divergent logic must survive untouched.
    const content = tree.read(TS_INDEX_FILE, 'utf-8') ?? '';
    expect(content).toContain("console.log('custom logging added by hand')");
    expect(content).not.toContain('SESSION_ID_MISMATCH');
    expect(content).not.toContain('threadId');
    expect(result.nextSteps).toEqual([
      `${TS_INDEX_FILE}: sessionIdMiddleware has diverged from the generated shape — manually add the session ID / thread ID mismatch check (see the ts#agent generator's ag-ui index.ts template).`,
    ]);
  });

  it('is idempotent', async () => {
    tree.write(PY_MAIN_FILE, BEFORE_PY);
    tree.write(TS_INDEX_FILE, BEFORE_TS);

    await migration(tree);
    const pyAfterFirstRun = tree.read(PY_MAIN_FILE, 'utf-8');
    const tsAfterFirstRun = tree.read(TS_INDEX_FILE, 'utf-8');

    const secondResult = await migration(tree);

    expect(tree.read(PY_MAIN_FILE, 'utf-8')).toEqual(pyAfterFirstRun);
    expect(tree.read(TS_INDEX_FILE, 'utf-8')).toEqual(tsAfterFirstRun);
    expect(secondResult.nextSteps).toEqual([]);
  });
});
