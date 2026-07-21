/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  addDependenciesToPackageJson,
  generateFiles,
  joinPathFragments,
  OverwriteStrategy,
  type Tree,
} from '@nx/devkit';
import {
  PACKAGES_DIR,
  SHARED_SCRIPTS_DIR,
} from './shared-constructs-constants';
import { ensureSharedScriptsProject } from './shared-scripts';
import { withVersions } from './versions';

/**
 * Ensures the shared scripts package exists and adds OpenSearch local-dev
 * scripts to packages/common/scripts/src/opensearch/. Shared by every
 * ts#opensearch project so a single classic OpenSearch container serves the
 * whole workspace.
 */
export async function sharedOpenSearchScriptsGenerator(
  tree: Tree,
): Promise<void> {
  const scriptsDir = joinPathFragments(PACKAGES_DIR, SHARED_SCRIPTS_DIR);

  await ensureSharedScriptsProject(tree);

  generateFiles(
    tree,
    joinPathFragments(
      import.meta.dirname,
      'files',
      SHARED_SCRIPTS_DIR,
      'src',
      'opensearch',
    ),
    joinPathFragments(scriptsDir, 'src', 'opensearch'),
    {},
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  addDependenciesToPackageJson(
    tree,
    withVersions(['@opensearch-project/opensearch']),
    withVersions(['tsx']),
  );
}
