/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  addDependenciesToPackageJson,
  type GeneratorCallback,
  generateFiles,
  installPackagesTask,
  joinPathFragments,
  readProjectConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { resolveContainers } from '../../utils/containers';
import { formatFilesInSubtree } from '../../utils/format';
import { resolveIac } from '../../utils/iac';
import { addGeneratorMetricsIfApplicable } from '../../utils/metrics';
import { kebabCase, toClassName } from '../../utils/names';
import { getNpmScope, toScopeAlias } from '../../utils/npm-scope';
import {
  addGeneratorMetadata,
  getGeneratorInfo,
  type NxGeneratorInfo,
} from '../../utils/nx';
import { assignSharedPort } from '../../utils/port';
import { sharedConstructsGenerator } from '../../utils/shared-constructs';
import { withVersions } from '../../utils/versions';
import { addOpenSearchInfra } from '../../utils/opensearch-constructs/opensearch-constructs';
import tsProjectGenerator, { getTsLibDetails } from '../lib/generator';
import type { TsOpenSearchGeneratorSchema } from './schema';

export const TS_OPENSEARCH_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(__filename);

const OPENSEARCH_IMAGE =
  'public.ecr.aws/opensearchproject/opensearch:latest';

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
    });
  }

  const projectConfig = readProjectConfiguration(tree, fullyQualifiedName);

  const localOpenSearchPort = assignSharedPort(
    tree,
    projectConfig,
    TS_OPENSEARCH_GENERATOR_INFO.id,
    9200,
  );

  const templateOptions = {
    runtimeConfigKey: nameClassName,
    openSearchPackageAlias: toScopeAlias(fullyQualifiedName),
    localOpenSearchPort,
    containerEngine,
    nameKebabCase,
  };

  generateFiles(
    tree,
    joinPathFragments(__dirname, 'files'),
    dir,
    templateOptions,
  );

  const containerName = `${getNpmScope(tree)}-opensearch`;

  projectConfig.targets['pull-image'] = {
    executor: 'nx:run-commands',
    options: {
      command: `tsx scripts/pull-image.ts ${OPENSEARCH_IMAGE}`,
      cwd: '{projectRoot}',
    },
  };
  projectConfig.targets['serve-local'] = {
    executor: 'nx:run-commands',
    continuous: true,
    dependsOn: ['pull-image'],
    options: {
      commands: [
        `tsx scripts/start-container.ts ${containerName} ${OPENSEARCH_IMAGE} ${localOpenSearchPort}`,
        `tsx scripts/wait-for-opensearch.ts ${localOpenSearchPort}`,
      ],
      parallel: true,
      cwd: '{projectRoot}',
    },
  };

  updateProjectConfiguration(tree, fullyQualifiedName, projectConfig);
  addGeneratorMetadata(tree, fullyQualifiedName, TS_OPENSEARCH_GENERATOR_INFO);

  if (options.infra === 'serverless') {
    const iac = await resolveIac(tree, options.iac);
    await sharedConstructsGenerator(tree, { iac });
    await addOpenSearchInfra(tree, {
      iac,
      projectName: fullyQualifiedName,
      nameClassName,
      nameKebabCase,
      openSearchPackageAlias: toScopeAlias(fullyQualifiedName),
    });
  }

  addDependenciesToPackageJson(
    tree,
    withVersions(['@opensearch-project/opensearch', '@aws-lambda-powertools/parameters']),
    withVersions(['tsx', '@types/aws-lambda']),
  );

  await addGeneratorMetricsIfApplicable(tree, [TS_OPENSEARCH_GENERATOR_INFO]);

  await formatFilesInSubtree(tree);
  return () => {
    installPackagesTask(tree);
  };
};

export default tsOpenSearchGenerator;
