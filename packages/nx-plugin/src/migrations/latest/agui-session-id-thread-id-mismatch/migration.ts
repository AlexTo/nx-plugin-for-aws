/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type MigrationReturnObject,
  type Tree,
  visitNotIgnoredFiles,
} from '@nx/devkit';
import { applyGritQL, insertViaGritQL, matchGritQL } from '../../../utils/ast';
import { formatFilesInSubtree } from '../../../utils/format';

/**
 * Reject an AG-UI /invocations request whose session ID header doesn't match
 * the request's own thread ID, in the Python (Strands + LangChain) and
 * TypeScript (Strands) ag-ui server templates.
 *
 * The web UI's useAgui hook and the agent-chat CLI both derive the AgentCore
 * session ID header from the request's thread ID, so a mismatch means the
 * request was routed to the wrong AgentCore session/container.
 *
 * How to write a migration:
 * - https://nx.dev/docs/kb/migration-generators
 * - What `nextSteps` means: https://nx.dev/docs/reference/devkit/MigrationReturnObject
 *
 * Guardrails:
 * - Pattern-match before writing: skip files that have diverged from the
 *   shape the generators produce and report them via `nextSteps`, rather
 *   than clobbering the user's changes.
 * - Idempotent: re-running must be a no-op.
 * - Format what you write: finish with `formatFilesInSubtree` so the files
 *   this migration wrote are formatted correctly.
 */

// Identical across the Strands and LangChain ag-ui main.py templates — the
// HTTP and A2A templates resolve session_id differently, so this line alone
// identifies an ag-ui main.py.
const PY_SESSION_ID_LINE =
  'session_id = request.headers.get(SESSION_ID_HEADER) or get_current_session_id()';

const PY_MISMATCH_CHECK_PATTERN =
  'language python\n`session_id = request.headers.get($header) or get_current_session_id()` => raw`session_id = request.headers.get($header) or get_current_session_id()\n    if session_id != input_data.thread_id.ljust(33, "0"):\n        message = f"Session ID {session_id!r} does not match thread ID {input_data.thread_id!r}"\n\n        async def _mismatch():\n            yield encoder.encode(RunErrorEvent(type=EventType.RUN_ERROR, message=message, code="SESSION_ID_MISMATCH"))\n\n        return StreamingResponse(_mismatch(), media_type=encoder.get_content_type())`';

const TS_IMPORT_INSERT_PATTERN =
  "`import { $names } from '@ag-ui/aws-strands/server';` => `import { $names } from '@ag-ui/aws-strands/server';\n__GRIT_INSERT_PLACEHOLDER__` where { $program <: not contains `@ag-ui/encoder` }";

const TS_IMPORT_TEXT = `import { EventType, type RunErrorEvent } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';`;

// Guarded on not already containing `threadId` so a second run (or an
// already-migrated file) is a no-op rather than re-wrapping the placeholder.
const TS_MIDDLEWARE_MATCH_PATTERN =
  '`const sessionIdMiddleware = ($params) => $body;` => `__GRIT_INSERT_PLACEHOLDER__` where { $body <: contains `runWithSessionId(sessionId, () => next())`, $body <: not contains `threadId` }';

const TS_MIDDLEWARE_TEXT = `const sessionIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers[SESSION_ID_HEADER];
  const sessionId = (Array.isArray(header) ? header[0] : header) ?? randomUUID();

  const threadId = req.body?.threadId;
  if (typeof threadId === 'string' && sessionId !== threadId.padEnd(33, '0')) {
    const encoder = new EventEncoder({ accept: req.headers.accept });
    const event: RunErrorEvent = {
      type: EventType.RUN_ERROR,
      message: \`Session ID \${sessionId} does not match thread ID \${threadId}\`,
      code: 'SESSION_ID_MISMATCH',
    };
    res.setHeader('Content-Type', encoder.getContentType());
    res.write(
      encoder.getContentType() === 'text/event-stream'
        ? encoder.encode(event)
        : Buffer.from(encoder.encodeBinary(event)),
    );
    res.end();
    return;
  }

  runWithSessionId(sessionId, () => next());
};`;

export default async function migration(
  tree: Tree,
): Promise<MigrationReturnObject> {
  const nextSteps: string[] = [];

  const filePaths: string[] = [];
  visitNotIgnoredFiles(tree, '', (filePath) => filePaths.push(filePath));

  for (const filePath of filePaths) {
    if (filePath.endsWith('/main.py')) {
      const content = tree.read(filePath, 'utf-8') ?? '';
      if (
        !content.includes(PY_SESSION_ID_LINE) ||
        content.includes('SESSION_ID_MISMATCH')
      ) {
        continue;
      }

      const applied = await applyGritQL(
        tree,
        filePath,
        PY_MISMATCH_CHECK_PATTERN,
      );
      if (!applied) {
        nextSteps.push(
          `${filePath}: could not add the session ID / thread ID mismatch check automatically — see the py#agent generator's ag-ui main.py template for the expected shape.`,
        );
      }
      continue;
    }

    if (filePath.endsWith('/index.ts')) {
      const content = tree.read(filePath, 'utf-8') ?? '';
      if (
        !content.includes('sessionIdMiddleware') ||
        !content.includes("from '@ag-ui/aws-strands/server'") ||
        content.includes('SESSION_ID_MISMATCH')
      ) {
        continue;
      }

      if (!(await matchGritQL(tree, filePath, TS_MIDDLEWARE_MATCH_PATTERN))) {
        nextSteps.push(
          `${filePath}: sessionIdMiddleware has diverged from the generated shape — manually add the session ID / thread ID mismatch check (see the ts#agent generator's ag-ui index.ts template).`,
        );
        continue;
      }

      await insertViaGritQL(
        tree,
        filePath,
        TS_MIDDLEWARE_MATCH_PATTERN,
        TS_MIDDLEWARE_TEXT,
      );
      await insertViaGritQL(
        tree,
        filePath,
        TS_IMPORT_INSERT_PATTERN,
        TS_IMPORT_TEXT,
      );
    }
  }

  await formatFilesInSubtree(tree);

  return { nextSteps };
}
