/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  getProjects,
  joinPathFragments,
  type MigrationReturnObject,
  type ProjectConfiguration,
  type Tree,
  visitNotIgnoredFiles,
} from '@nx/devkit';
import { PY_AGENT_GENERATOR_INFO } from '../../../py/agent/generator';
import {
  addPythonReExport,
  getPythonAgentConnectionModuleName,
  getPythonAgentConnectionProjectDir,
} from '../../../utils/agent-connection/agent-connection';
import {
  applyGritQL,
  captureGritQLVariable,
  matchGritQL,
} from '../../../utils/ast';
import { formatFilesInSubtree } from '../../../utils/format';
import { kebabCase } from '../../../utils/names';
import type { ComponentMetadata } from '../../../utils/nx';
import {
  getRelativePathToRootByDirectory,
  toProjectRelativePath,
} from '../../../utils/paths';

/**
 * Add session management support to py#agent (Strands framework only —
 * LangChain's LangGraph checkpointer is a separate mechanism this feature
 * doesn't touch).
 *
 * How to write a migration:
 * - https://nx.dev/docs/kb/migration-generators
 * - What `nextSteps` means: https://nx.dev/docs/reference/devkit/MigrationReturnObject
 *
 * Guardrails:
 * - Pattern-match before writing: skip files that have diverged from the shape
 *   your generators produce and report them via `nextSteps`, rather than
 *   clobbering the user's changes.
 * - Idempotent: re-running must be a no-op.
 * - Format what you write: finish with `formatFilesInSubtree` so the files
 *   this migration wrote are formatted correctly.
 */

// Captures the agent-connection module a file imports `log_model_errors` (or
// `session_id_context`) from, and gates every rewrite below on the import
// actually being present. Generic over `$names` since a connection generator
// may have merged its own import into the same line.
const LOG_MODEL_ERRORS_IMPORT_CAPTURE_PATTERN =
  'language python\n`from $mod import $names` where { $names <: contains `log_model_errors` }';
const SESSION_ID_CONTEXT_IMPORT_CAPTURE_PATTERN =
  'language python\n`from $mod import $names` where { $names <: contains `session_id_context` }';

// Every strands agent.py already hooks log_model_errors regardless of
// protocol (hooks, unlike session_manager, carry over per-thread for AG-UI
// without special wiring — see StrandsAgent's kwargs-forwarding), so
// log_tool_errors is retrofitted the same way for every protocol.
const LOG_TOOL_ERRORS_IMPORT_PATTERN =
  'language python\n`from $mod import $names` => `from $mod import $names, log_tool_errors` where { $names <: contains `log_model_errors`, $names <: not contains `log_tool_errors` }';
const LOG_TOOL_ERRORS_HOOKS_PATTERN =
  'language python\n`hooks=[$hooks]` => `hooks=[$hooks, log_tool_errors]` where { $hooks <: contains `log_model_errors`, $hooks <: not contains `log_tool_errors` }';

// Existing agent-connection projects predate tool_errors_strands.py — mirrors
// the py#agent generator's own py-core-strands/base/tool_errors_strands.py.template.
const TOOL_ERRORS_STRANDS_PY_CONTENT = `import logging

from strands.hooks import AfterToolCallEvent, HookRegistry

logger = logging.getLogger(__name__)


class _LogToolErrors:
    def register_hooks(self, registry: HookRegistry, **_kwargs) -> None:
        registry.add_callback(AfterToolCallEvent, self._on_after_tool_call)

    @staticmethod
    def _on_after_tool_call(event: AfterToolCallEvent) -> None:
        tool_name = event.tool_use.get("name", "<unknown>")
        if event.exception is not None:
            logger.error("Tool '%s' failed: %s", tool_name, event.exception)
            return
        if event.result.get("status") != "error":
            return
        message = " ".join(block["text"] for block in event.result.get("content", []) if "text" in block)
        logger.error("Tool '%s' failed%s", tool_name, f": {message}" if message else "")


log_tool_errors = _LogToolErrors()
`;

/**
 * Ensures the shared Python agent-connection project has tool_errors_strands.py
 * and re-exports log_tool_errors, backfilling projects generated before this
 * helper existed. Returns false (and leaves the tree untouched) if the
 * agent-connection project itself can't be found.
 */
async function ensureToolErrorsBase(tree: Tree): Promise<boolean> {
  const projectDir = getPythonAgentConnectionProjectDir(tree);
  if (!tree.exists(joinPathFragments(projectDir, 'project.json'))) {
    return false;
  }
  const moduleDir = joinPathFragments(
    projectDir,
    getPythonAgentConnectionModuleName(tree),
  );
  const toolErrorsPath = joinPathFragments(
    moduleDir,
    'core',
    'tool_errors_strands.py',
  );
  if (!tree.exists(toolErrorsPath)) {
    tree.write(toolErrorsPath, TOOL_ERRORS_STRANDS_PY_CONTENT);
  }
  await addPythonReExport(
    tree,
    joinPathFragments(moduleDir, '__init__.py'),
    '.core.tool_errors_strands',
    'log_tool_errors',
  );
  return true;
}

// HTTP/A2A agents build one Agent per session (via with_session_id), so
// wiring `session_manager` directly into the constructor is safe. Anchored
// on a `tools=` keyword argument so this only matches an inline kwargs call
// (as the generator produces), not e.g. `Agent(**agent_kwargs)`.
const AGENT_PY_CONSTRUCTOR_MATCH_PATTERN =
  'language python\n`Agent($args)` where { $args <: contains `tools=$_` }';
const AGENT_PY_SESSION_MANAGER_CONSTRUCTOR_PATTERN = `${AGENT_PY_CONSTRUCTOR_MATCH_PATTERN} => \`Agent(session_manager=get_session_manager(), $args)\` where { $args <: not contains \`session_manager\` }`;

// Adds the sibling session.py import to agent.py, once session.py exists.
const AGENT_PY_SESSION_IMPORT_PATTERN =
  'language python\n`from $mod import $names` => raw`from $mod import $names\n\nfrom .session import get_session_manager` where { $names <: contains `log_model_errors`, $program <: not contains `from .session import get_session_manager` }';

// AG-UI's StrandsAgent adapter needs a session_manager_provider (called once
// per thread_id) rather than a plain session_manager, mirroring
// AGENT_PY_SESSION_MANAGER_CONSTRUCTOR_PATTERN.
const AGUI_MAIN_IMPORT_PATTERN =
  'language python\n`from ag_ui_strands import $names` => `from ag_ui_strands import StrandsAgentConfig, $names` where { $names <: contains `StrandsAgent`, $names <: not contains `StrandsAgentConfig` }';
const AGUI_MAIN_CONSTRUCTOR_MATCH_PATTERN =
  'language python\n`StrandsAgent($args)` where { $args <: contains `agent=$_` }';
const AGUI_MAIN_CONSTRUCTOR_PATTERN = `${AGUI_MAIN_CONSTRUCTOR_MATCH_PATTERN} => \`StrandsAgent(config=StrandsAgentConfig(session_manager_provider=lambda _input_data: get_session_manager()), $args)\` where { $args <: not contains \`config=\` }`;
const AGUI_MAIN_SESSION_IMPORT_PATTERN =
  'language python\n`from .agent import get_agent` => raw`from .agent import get_agent\nfrom .session import get_session_manager` where { $program <: not contains `from .session import get_session_manager` }';

// Existing agents predate session.py, so there's no prior storage to
// preserve — default to in-memory, mirroring the ts#agent migration.
const legacySessionManagerContent = (
  agentConnectionModule: string,
  localSessionsDir: string,
): string =>
  `import os

from strands.session import FileSessionManager, SessionManager

from ${agentConnectionModule} import get_current_session_id


def get_session_manager() -> SessionManager | None:
    """Returns a SessionManager for persisting conversation state across
    invocations. Local development always uses local file storage for
    convenience, regardless of the configured session option. Without a
    configured session option, conversation state is kept in memory only and
    does not survive process restarts.
    """
    session_id = get_current_session_id()
    if not session_id:
        raise RuntimeError(
            "No current session id — cannot resolve a SessionManager outside of a request scope."
        )
    if os.environ.get("LOCAL_DEV") == "true":
        return FileSessionManager(session_id=session_id, storage_dir="${localSessionsDir}")
    return None
`;

/** The Nx project owning `dirPath`, if any (the longest-matching project.root). */
const findOwningProject = (
  tree: Tree,
  dirPath: string,
): ProjectConfiguration | undefined => {
  let best: ProjectConfiguration | undefined;
  for (const project of getProjects(tree).values()) {
    if (
      (dirPath === project.root || dirPath.startsWith(`${project.root}/`)) &&
      (!best || project.root.length > best.root.length)
    ) {
      best = project;
    }
  }
  return best;
};

/** This agent's own ComponentMetadata entry, as written by the py#agent generator. */
const findAgentComponentMetadata = (
  project: ProjectConfiguration,
  dirRelativeToProjectRoot: string,
): ComponentMetadata | undefined =>
  (project.metadata as { components?: ComponentMetadata[] })?.components?.find(
    (component) =>
      component.generator === PY_AGENT_GENERATOR_INFO.id &&
      component.path === dirRelativeToProjectRoot,
  );

/** This agent's real kebab-case name, from ComponentMetadata's `rc` (class-name) field. */
const agentTmpNameFor = (
  project: ProjectConfiguration,
  dir: string,
): string | undefined => {
  const dirRelativeToProjectRoot = toProjectRelativePath(project, dir);
  const rc = findAgentComponentMetadata(project, dirRelativeToProjectRoot)?.rc;
  return rc ? kebabCase(rc) : undefined;
};

/** This agent's protocol + framework, from its ComponentMetadata entry. */
const agentComponentFor = (
  project: ProjectConfiguration,
  dir: string,
): ComponentMetadata | undefined => {
  const dirRelativeToProjectRoot = toProjectRelativePath(project, dir);
  return findAgentComponentMetadata(project, dirRelativeToProjectRoot);
};

/** The relative path from `projectRoot` up to this agent's workspace-root-level local session storage. */
const localSessionsDirFor = (
  projectRoot: string,
  agentTmpName: string,
): string =>
  `${getRelativePathToRootByDirectory(projectRoot)}tmp/agents/strands/${agentTmpName}`;

export default async function migration(
  tree: Tree,
): Promise<MigrationReturnObject> {
  const nextSteps: string[] = [];

  const filePaths: string[] = [];
  visitNotIgnoredFiles(tree, '', (filePath) => filePaths.push(filePath));

  for (const filePath of filePaths) {
    if (filePath.endsWith('/agent.py')) {
      // log_tool_errors applies to every protocol (unlike session_manager),
      // so retrofit it independently of whether the owning project can be
      // resolved below. LOG_TOOL_ERRORS_HOOKS_PATTERN's own `where` clause
      // (contains log_model_errors, not already containing log_tool_errors)
      // doubles as the "still needs retrofitting" check.
      if (await matchGritQL(tree, filePath, LOG_TOOL_ERRORS_HOOKS_PATTERN)) {
        if (await ensureToolErrorsBase(tree)) {
          await applyGritQL(tree, filePath, LOG_TOOL_ERRORS_IMPORT_PATTERN);
          await applyGritQL(tree, filePath, LOG_TOOL_ERRORS_HOOKS_PATTERN);
        } else {
          nextSteps.push(
            `${filePath}: could not find the shared agent-connection project — manually add \`log_tool_errors\` to the hooks list (see the py#agent generator's template).`,
          );
        }
      }

      const dir = filePath.split('/').slice(0, -1).join('/');
      const project = findOwningProject(tree, dir);

      // Without a registered project there's no ComponentMetadata, so this
      // agent's protocol/framework/agent-connection module can't be
      // resolved — and a pre-migration AG-UI agent.py is textually identical
      // to an HTTP/A2A one, so there's nothing left to safely guess from.
      if (!project) {
        if (
          await matchGritQL(
            tree,
            filePath,
            LOG_MODEL_ERRORS_IMPORT_CAPTURE_PATTERN,
          )
        ) {
          nextSteps.push(
            `${filePath}: could not determine the project root — manually verify whether this is an AG-UI or HTTP/A2A Strands agent and wire session_manager in accordingly (see the py#agent generator's template).`,
          );
        }
        continue;
      }

      const component = agentComponentFor(project, dir);

      // No session concept for LangChain (its LangGraph checkpointer is a
      // separate mechanism this feature doesn't touch).
      if (component?.framework === 'langchain') {
        continue;
      }

      // AG-UI wires session_manager_provider on the StrandsAgent adapter in
      // main.py instead — handled by the branch below.
      if (component?.protocol === 'ag-ui') {
        continue;
      }

      if (!component?.protocol) {
        if (
          await matchGritQL(
            tree,
            filePath,
            LOG_MODEL_ERRORS_IMPORT_CAPTURE_PATTERN,
          )
        ) {
          nextSteps.push(
            `${filePath}: could not determine this agent's protocol/framework from its ComponentMetadata — manually verify whether it's AG-UI or HTTP/A2A Strands and wire session_manager in accordingly (see the py#agent generator's template).`,
          );
        }
        continue;
      }

      // HTTP/A2A: wire session_manager into the Agent constructor and create
      // the sibling session.py if it doesn't exist yet.
      if (
        !(await matchGritQL(
          tree,
          filePath,
          LOG_MODEL_ERRORS_IMPORT_CAPTURE_PATTERN,
        ))
      ) {
        continue;
      }

      const sessionPath = `${dir}/session.py`;

      if (
        !(await matchGritQL(tree, filePath, AGENT_PY_CONSTRUCTOR_MATCH_PATTERN))
      ) {
        nextSteps.push(
          `${filePath}: the Agent is not constructed with an inline \`Agent(...)\` call, so session_manager could not be wired in automatically. Manually add \`session_manager=get_session_manager()\` to its constructor (see the py#agent generator's template), creating ${sessionPath} first if it doesn't already exist.`,
        );
        continue;
      }

      if (!tree.exists(sessionPath)) {
        const mod = await captureGritQLVariable(
          tree,
          filePath,
          LOG_MODEL_ERRORS_IMPORT_CAPTURE_PATTERN,
          'mod',
        );
        const agentName = agentTmpNameFor(project, dir);

        if (mod && agentName) {
          tree.write(
            sessionPath,
            legacySessionManagerContent(
              mod,
              localSessionsDirFor(project.root, agentName),
            ),
          );
        } else {
          nextSteps.push(
            `${filePath}: could not determine the agent-connection module or this agent's name from its ComponentMetadata — manually create ${sessionPath} (see the py#agent generator's template) and wire \`session_manager=get_session_manager()\` into the Agent constructor.`,
          );
          continue;
        }
      }

      await applyGritQL(tree, filePath, AGENT_PY_SESSION_IMPORT_PATTERN);

      if (
        !(tree.read(filePath, 'utf-8') ?? '').includes('get_session_manager')
      ) {
        nextSteps.push(
          `${filePath}: found ${sessionPath} but couldn't confirm the get_session_manager import — wire \`session_manager=get_session_manager()\` into the Agent constructor manually.`,
        );
        continue;
      }

      await applyGritQL(
        tree,
        filePath,
        AGENT_PY_SESSION_MANAGER_CONSTRUCTOR_PATTERN,
      );
      continue;
    }

    if (
      filePath.endsWith('/main.py') &&
      (tree.read(filePath, 'utf-8') ?? '').includes('ag_ui_strands')
    ) {
      const alreadyWired = (tree.read(filePath, 'utf-8') ?? '').includes(
        'StrandsAgentConfig',
      );

      if (!alreadyWired) {
        const needsWiring = await matchGritQL(
          tree,
          filePath,
          AGUI_MAIN_CONSTRUCTOR_MATCH_PATTERN,
        );
        if (!needsWiring) {
          nextSteps.push(
            `${filePath}: the StrandsAgent constructor has diverged from the generated shape - left as-is. Manually add \`config=StrandsAgentConfig(session_manager_provider=lambda _input_data: get_session_manager())\` to it (see the py#agent generator's template).`,
          );
          continue;
        }

        await applyGritQL(tree, filePath, AGUI_MAIN_IMPORT_PATTERN);
        await applyGritQL(tree, filePath, AGUI_MAIN_CONSTRUCTOR_PATTERN);
      }

      const dir = filePath.split('/').slice(0, -1).join('/');
      const sessionPath = `${dir}/session.py`;

      if (!tree.exists(sessionPath)) {
        const project = findOwningProject(tree, dir);
        const mod = await captureGritQLVariable(
          tree,
          filePath,
          SESSION_ID_CONTEXT_IMPORT_CAPTURE_PATTERN,
          'mod',
        );
        const agentName = project && agentTmpNameFor(project, dir);

        if (project && mod && agentName) {
          tree.write(
            sessionPath,
            legacySessionManagerContent(
              mod,
              localSessionsDirFor(project.root, agentName),
            ),
          );
        } else {
          nextSteps.push(
            `${filePath}: could not determine the project root, agent-connection module, or this agent's name from its ComponentMetadata — manually create ${sessionPath} (see the py#agent generator's template) and wire \`config=StrandsAgentConfig(session_manager_provider=lambda _input_data: get_session_manager())\` into the StrandsAgent constructor.`,
          );
          continue;
        }
      }

      await applyGritQL(tree, filePath, AGUI_MAIN_SESSION_IMPORT_PATTERN);

      if (
        !(tree.read(filePath, 'utf-8') ?? '').includes('get_session_manager')
      ) {
        nextSteps.push(
          `${filePath}: found ${sessionPath} but couldn't confirm the get_session_manager import — wire it into the StrandsAgent constructor manually.`,
        );
      }
    }
  }

  await formatFilesInSubtree(tree);

  return { nextSteps };
}
