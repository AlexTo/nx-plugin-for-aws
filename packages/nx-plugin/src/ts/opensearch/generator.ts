/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { relative } from 'node:path';
import {
  addDependenciesToPackageJson,
  type GeneratorCallback,
  generateFiles,
  joinPathFragments,
  readProjectConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { resolveContainers } from '../../utils/containers';
import { formatFilesInSubtree } from '../../utils/format';
import { resolveIac } from '../../utils/iac';
import { installDependencies } from '../../utils/install';
import { addGeneratorMetricsIfApplicable } from '../../utils/metrics';
import { esmVars } from '../../utils/module-format';
import { kebabCase, toClassName } from '../../utils/names';
import { getNpmScope } from '../../utils/npm-scope';
import {
  addDependencyToTargetIfNotPresent,
  addGeneratorMetadata,
  getGeneratorInfo,
  type NxGeneratorInfo,
} from '../../utils/nx';
import { addOpenSearchInfra } from '../../utils/opensearch-constructs/opensearch-constructs';
import { assignSharedPort } from '../../utils/port';
import { sharedConstructsGenerator } from '../../utils/shared-constructs';
import {
  OPENSEARCH_GENERATOR_IDS,
  PACKAGES_DIR,
  SHARED_SCRIPTS_DIR,
} from '../../utils/shared-constructs-constants';
import { sharedOpenSearchScriptsGenerator } from '../../utils/shared-opensearch-scripts';
import { withVersions } from '../../utils/versions';
import tsProjectGenerator, { getTsLibDetails } from '../lib/generator';
import type { TsOpenSearchGeneratorSchema } from './schema';

export const TS_OPENSEARCH_GENERATOR_INFO: NxGeneratorInfo = getGeneratorInfo(
  import.meta.filename,
);

export const tsOpenSearchGenerator = async (
  tree: Tree,
  options: TsOpenSearchGeneratorSchema,
): Promise<GeneratorCallback> => {
  const nameKebabCase = kebabCase(options.name);
  const nameClassName = toClassName(options.name);
  const containerEngine = await resolveContainers(tree, 'inherit');
  const { fullyQualifiedName, dir } = getTsLibDetails(tree, {
    name: options.name,
    directory: options.directory,
    subDirectory: options.subDirectory,
  });

  let projectExists: boolean;
  try {
    readProjectConfiguration(tree, fullyQualifiedName);
    projectExists = true;
  } catch {
    projectExists = false;
  }

  if (!projectExists) {
    await tsProjectGenerator(tree, {
      name: options.name,
      directory: options.directory,
      preferInstallDependencies: false,
    });
  }

  const projectConfig = readProjectConfiguration(tree, fullyQualifiedName);

  const localOpenSearchPort = assignSharedPort(
    tree,
    projectConfig,
    OPENSEARCH_GENERATOR_IDS,
    9200,
  );

  const containerName = `${getNpmScope(tree)}-opensearch`;

  const templateOptions = {
    runtimeConfigKey: nameClassName,
    localOpenSearchPort,
    containerName,
    containerEngine,
    ...esmVars(tree),
  };

  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files'),
    dir,
    templateOptions,
  );

  await sharedOpenSearchScriptsGenerator(tree);

  const scriptsDir = relative(
    dir,
    joinPathFragments(PACKAGES_DIR, SHARED_SCRIPTS_DIR, 'src', 'opensearch'),
  );

  projectConfig.targets['pull-image'] = {
    executor: 'nx:run-commands',
    options: {
      command: `tsx ${scriptsDir}/pull-image.ts`,
      cwd: '{projectRoot}',
    },
  };
  projectConfig.targets['dev'] = {
    executor: 'nx:run-commands',
    continuous: true,
    options: {
      commands: [
        `tsx ${scriptsDir}/start-container.ts`,
        `tsx ${scriptsDir}/create-local-indices.ts`,
      ],
      parallel: true,
      cwd: '{projectRoot}',
    },
  };
  // Keeps config.json's `indices` snapshot fresh from the zod schemas under
  // src/indices/ on every build, so common/constructs (a separate Nx project
  // that can't import these zod modules directly at synth time) always
  // declares indices matching the current schema.
  projectConfig.targets['sync-mappings'] = {
    executor: 'nx:run-commands',
    options: {
      command: `tsx ${scriptsDir}/sync-index-mappings.ts`,
      cwd: '{projectRoot}',
    },
  };
  addDependencyToTargetIfNotPresent(projectConfig, 'build', 'sync-mappings');

  updateProjectConfiguration(tree, fullyQualifiedName, projectConfig);
  addGeneratorMetadata(tree, fullyQualifiedName, TS_OPENSEARCH_GENERATOR_INFO);

  if (options.infra !== 'none') {
    const iac = await resolveIac(tree, options.iac);
    await sharedConstructsGenerator(tree, { iac });
    await addOpenSearchInfra(tree, {
      iac,
      projectName: fullyQualifiedName,
      nameClassName,
      nameKebabCase,
      projectRoot: dir,
    });
  }

  addDependenciesToPackageJson(
    tree,
    withVersions([
      '@opensearch-project/opensearch',
      '@aws-sdk/credential-provider-node',
      'zod',
      '@aws-lambda-powertools/parameters',
      '@aws-sdk/client-appconfigdata',
    ]),
    withVersions(['tsx', '@types/node']),
  );

  await addGeneratorMetricsIfApplicable(tree, [TS_OPENSEARCH_GENERATOR_INFO]);

  await formatFilesInSubtree(tree);
  return () =>
    installDependencies(tree, options.preferInstallDependencies, {
      languages: ['typescript'],
    });
};

export default tsOpenSearchGenerator;
