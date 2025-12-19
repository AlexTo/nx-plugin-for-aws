/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  addDependenciesToPackageJson,
  generateFiles,
  getPackageManagerCommand,
  joinPathFragments,
  OverwriteStrategy,
  Tree,
  updateJson,
} from '@nx/devkit';
import { libraryGenerator } from '@nx/react';
import { configureTsProject } from '../ts/lib/ts-project-utils';
import { formatFilesInSubtree } from './format';
import { getNpmScopePrefix, toScopeAlias } from './npm-scope';
import {
  PACKAGES_DIR,
  SHARED_SHADCN_DIR,
  SHARED_SHADCN_NAME,
} from './shared-constructs-constants';
import { withVersions } from './versions';

const SHADCN_DEPS = [
  'class-variance-authority',
  'clsx',
  'lucide-react',
  'tailwind-merge',
  'tailwindcss-animate',
] as const;

export async function sharedShadcnGenerator(tree: Tree) {
  const npmScopePrefix = getNpmScopePrefix(tree);
  const fullyQualifiedName = `${npmScopePrefix}${SHARED_SHADCN_NAME}`;
  const libraryRoot = joinPathFragments(PACKAGES_DIR, SHARED_SHADCN_DIR);
  const shadcnSrcRoot = joinPathFragments(libraryRoot, 'src');
  let didChange = false;

  if (!tree.exists(joinPathFragments(libraryRoot, 'project.json'))) {
    await libraryGenerator(tree, {
      name: fullyQualifiedName,
      directory: libraryRoot,
      bundler: 'vite',
      unitTestRunner: 'vitest',
      linter: 'eslint',
      style: 'css',
    });

    tree.delete(shadcnSrcRoot);

    generateFiles(
      tree,
      joinPathFragments(__dirname, 'files', 'common', 'shadcn', 'src'),
      shadcnSrcRoot,
      {
        scopeAlias: toScopeAlias(npmScopePrefix),
      },
      {
        overwriteStrategy: OverwriteStrategy.KeepExisting,
      },
    );

    generateFiles(
      tree,
      joinPathFragments(__dirname, 'files', 'common', 'shadcn'),
      libraryRoot,
      {
        fullyQualifiedName,
        pkgMgrCmd: getPackageManagerCommand().exec,
        scopeAlias: toScopeAlias(npmScopePrefix),
      },
      {
        overwriteStrategy: OverwriteStrategy.KeepExisting,
      },
    );

    configureTsProject(tree, {
      dir: libraryRoot,
      fullyQualifiedName,
    });

    updateJson(tree, joinPathFragments(libraryRoot, 'tsconfig.json'), (json) => ({
      ...json,
      compilerOptions: {
        ...json.compilerOptions,
        paths: {
          ...(json.compilerOptions?.paths ?? {}),
          '@/*': ['./src/*'],
        },
      },
    }));

    updateJson(
      tree,
      joinPathFragments(libraryRoot, 'tsconfig.lib.json'),
      (json) => ({
        ...json,
        compilerOptions: {
          ...json.compilerOptions,
          jsx: 'react-jsx',
          lib: Array.from(
            new Set([...(json.compilerOptions?.lib ?? []), 'DOM']),
          ),
        },
      }),
    );

    addDependenciesToPackageJson(tree, withVersions([...SHADCN_DEPS]), {});
    didChange = true;
  }

  if (!tree.exists('components.json')) {
    generateFiles(
      tree,
      joinPathFragments(__dirname, 'files', 'shadcn'),
      '.',
      {},
      {
        overwriteStrategy: OverwriteStrategy.KeepExisting,
      },
    );
    didChange = true;
  }

  if (didChange) {
    await formatFilesInSubtree(tree);
  }
}
