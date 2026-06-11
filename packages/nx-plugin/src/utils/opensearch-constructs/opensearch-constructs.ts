/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  generateFiles,
  joinPathFragments,
  OverwriteStrategy,
  type ProjectConfiguration,
  type Tree,
  updateJson,
} from '@nx/devkit';
import { addStarExport } from '../ast';
import type { Iac } from '../iac';
import { addDependencyToTargetIfNotPresent } from '../nx';
import {
  PACKAGES_DIR,
  SHARED_CONSTRUCTS_DIR,
  SHARED_TERRAFORM_DIR,
} from '../shared-constructs-constants';

export interface AddOpenSearchConstructOptions {
  projectName: string;
  nameClassName: string;
  nameKebabCase: string;
  openSearchPackageAlias: string;
}

export const addOpenSearchInfra = async (
  tree: Tree,
  options: AddOpenSearchConstructOptions & { iac: Iac },
) => {
  if (options.iac === 'cdk') {
    await addOpenSearchCdkConstructs(tree, options);
  } else if (options.iac === 'terraform') {
    addOpenSearchTerraformModules(tree, options);
  } else {
    throw new Error(`Unsupported iac ${options.iac}`);
  }

  updateJson(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      options.iac === 'cdk' ? SHARED_CONSTRUCTS_DIR : SHARED_TERRAFORM_DIR,
      'project.json',
    ),
    (config: ProjectConfiguration) => {
      addDependencyToTargetIfNotPresent(
        config,
        'build',
        `${options.projectName}:build`,
      );
      return config;
    },
  );
};

export const addOpenSearchCdkConstructs = async (
  tree: Tree,
  options: AddOpenSearchConstructOptions,
) => {
  generateFiles(
    tree,
    joinPathFragments(__dirname, 'files', 'cdk', 'core'),
    joinPathFragments(PACKAGES_DIR, SHARED_CONSTRUCTS_DIR, 'src', 'core'),
    options,
    {
      overwriteStrategy: OverwriteStrategy.KeepExisting,
    },
  );

  generateFiles(
    tree,
    joinPathFragments(__dirname, 'files', 'cdk', 'app', 'opensearch'),
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'app',
      'opensearch',
    ),
    options,
    {
      overwriteStrategy: OverwriteStrategy.KeepExisting,
    },
  );

  await addStarExport(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'core',
      'opensearch',
      'index.ts',
    ),
    './serverless.js',
  );
  await addStarExport(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'core',
      'index.ts',
    ),
    './opensearch/index.js',
  );
  await addStarExport(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'app',
      'opensearch',
      'index.ts',
    ),
    `./${options.nameKebabCase}.js`,
  );
  await addStarExport(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'app',
      'index.ts',
    ),
    './opensearch/index.js',
  );
};

export const addOpenSearchTerraformModules = (
  tree: Tree,
  options: AddOpenSearchConstructOptions,
) => {
  generateFiles(
    tree,
    joinPathFragments(__dirname, 'files', 'terraform', 'core'),
    joinPathFragments(PACKAGES_DIR, SHARED_TERRAFORM_DIR, 'src', 'core'),
    options,
    {
      overwriteStrategy: OverwriteStrategy.KeepExisting,
    },
  );

  generateFiles(
    tree,
    joinPathFragments(__dirname, 'files', 'terraform', 'app', 'opensearch'),
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_TERRAFORM_DIR,
      'src',
      'app',
      'opensearch',
    ),
    options,
    {
      overwriteStrategy: OverwriteStrategy.KeepExisting,
    },
  );
};
