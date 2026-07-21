/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Tree } from '@nx/devkit';
import { resolveContainers } from '../../utils/containers';
import { expectHasMetricTags } from '../../utils/metrics.spec';
import { readProjectConfigurationUnqualified } from '../../utils/nx';
import { sharedConstructsGenerator } from '../../utils/shared-constructs';
import {
  createTreeUsingTsSolutionSetup,
  snapshotTreeDir,
} from '../../utils/test';
import {
  TS_OPENSEARCH_GENERATOR_INFO,
  tsOpenSearchGenerator,
} from './generator';

vi.mock('../../utils/containers', () => ({
  resolveContainers: vi.fn(),
}));

describe('ts#opensearch generator', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
    vi.mocked(resolveContainers).mockResolvedValue('docker');
  });

  const defaultOptions = {
    name: 'MySearch',
    directory: 'packages',
    infra: 'serverless' as const,
    iac: 'cdk' as const,
  };

  it('should generate the opensearch project', async () => {
    await tsOpenSearchGenerator(tree, defaultOptions);
    const packageJson = JSON.parse(tree.read('package.json', 'utf-8') ?? '{}');
    const projectConfig = readProjectConfigurationUnqualified(
      tree,
      '@proj/my-search',
    );

    snapshotTreeDir(tree, 'packages/my-search/src');
    snapshotTreeDir(tree, 'packages/common/scripts/src/opensearch');

    expect(
      tree.read('packages/common/constructs/src/core/opensearch.ts', 'utf-8'),
    ).toMatchSnapshot();
    expect(
      tree.read(
        'packages/common/constructs/src/app/opensearch/my-search.ts',
        'utf-8',
      ),
    ).toMatchSnapshot();
    expect(
      tree.read(
        'packages/common/constructs/src/app/opensearch/index.ts',
        'utf-8',
      ),
    ).toMatchSnapshot();
    expect(
      tree.read('packages/common/constructs/src/app/index.ts', 'utf-8'),
    ).toMatchSnapshot();

    expect(projectConfig.targets['pull-image']).toEqual({
      executor: 'nx:run-commands',
      options: {
        command: 'tsx ../common/scripts/src/opensearch/pull-image.ts',
        cwd: '{projectRoot}',
      },
    });
    expect(projectConfig.targets['dev']).toEqual({
      executor: 'nx:run-commands',
      continuous: true,
      options: {
        commands: [
          'tsx ../common/scripts/src/opensearch/start-container.ts',
          'tsx ../common/scripts/src/opensearch/create-local-indices.ts',
        ],
        parallel: true,
        cwd: '{projectRoot}',
      },
    });
    expect(projectConfig.targets['sync-mappings']).toEqual({
      executor: 'nx:run-commands',
      options: {
        command: 'tsx ../common/scripts/src/opensearch/sync-index-mappings.ts',
        cwd: '{projectRoot}',
      },
    });
    expect(projectConfig.targets['build'].dependsOn).toContain('sync-mappings');

    const sharedConstructsConfig = JSON.parse(
      tree.read('packages/common/constructs/project.json', 'utf-8') ?? '{}',
    );
    expect(sharedConstructsConfig.targets.build.dependsOn).toContain(
      '@proj/my-search:build',
    );

    expect(tree.exists('packages/my-search/config.json')).toBe(true);
    const configJson = JSON.parse(
      tree.read('packages/my-search/config.json', 'utf-8') ?? '{}',
    );
    expect(configJson.indices).toEqual([]);

    expect(
      packageJson.dependencies['@opensearch-project/opensearch'],
    ).toBeDefined();
    expect(
      packageJson.dependencies['@aws-sdk/credential-provider-node'],
    ).toBeDefined();
    expect(packageJson.dependencies['zod']).toBeDefined();
    expect(
      packageJson.dependencies['@aws-lambda-powertools/parameters'],
    ).toBeDefined();
    expect(
      packageJson.dependencies['@aws-sdk/client-appconfigdata'],
    ).toBeDefined();
    expect(packageJson.devDependencies['tsx']).toBeDefined();
    expect(packageJson.devDependencies['@types/node']).toBeDefined();
  });

  it('should generate scripts for finch engine', async () => {
    vi.mocked(resolveContainers).mockResolvedValue('finch');
    await tsOpenSearchGenerator(tree, defaultOptions);
    expect(
      tree.read('packages/my-search/config.json', 'utf-8'),
    ).toMatchSnapshot();
  });

  it('should generate terraform modules when iac is terraform', async () => {
    await tsOpenSearchGenerator(tree, {
      ...defaultOptions,
      iac: 'terraform',
    });
    expect(
      tree.read(
        'packages/common/terraform/src/core/opensearch/opensearch.tf',
        'utf-8',
      ),
    ).toMatchSnapshot();
    expect(
      tree.read(
        'packages/common/terraform/src/app/opensearch/my-search/my-search.tf',
        'utf-8',
      ),
    ).toMatchSnapshot();
    const sharedTerraformConfig = JSON.parse(
      tree.read('packages/common/terraform/project.json', 'utf-8') ?? '{}',
    );
    expect(sharedTerraformConfig.targets.build.dependsOn).toContain(
      '@proj/my-search:build',
    );
  });

  it('should keep an existing opensearch app construct', async () => {
    await sharedConstructsGenerator(tree, { iac: 'cdk' });
    tree.write(
      'packages/common/constructs/src/app/opensearch/my-search.ts',
      '// preserve custom construct',
    );

    await tsOpenSearchGenerator(tree, defaultOptions);

    expect(
      tree
        .read(
          'packages/common/constructs/src/app/opensearch/my-search.ts',
          'utf-8',
        )
        ?.trim(),
    ).toBe('// preserve custom construct');
  });

  it('should add generator metric to app.ts', async () => {
    await sharedConstructsGenerator(tree, { iac: 'cdk' });

    await tsOpenSearchGenerator(tree, defaultOptions);

    expectHasMetricTags(tree, TS_OPENSEARCH_GENERATOR_INFO.metric);
  });

  it('should reuse port from existing ts#opensearch project', async () => {
    await tsOpenSearchGenerator(tree, defaultOptions);
    await tsOpenSearchGenerator(tree, {
      ...defaultOptions,
      name: 'OtherSearch',
    });

    const firstConfig = readProjectConfigurationUnqualified(
      tree,
      '@proj/my-search',
    );
    const secondConfig = readProjectConfigurationUnqualified(
      tree,
      '@proj/other-search',
    );

    const portOf = (cfg: typeof firstConfig) =>
      (cfg.metadata as any)?.ports?.[0] as number | undefined;

    expect(portOf(secondConfig)).toBe(portOf(firstConfig));
    const secondConfigJson = JSON.parse(
      tree.read('packages/other-search/config.json', 'utf-8') ?? '{}',
    );
    expect(secondConfigJson.localDev.port).toBe(portOf(firstConfig));
  });

  it('should generate with infra=none then upgrade to infra=serverless', async () => {
    await tsOpenSearchGenerator(tree, { ...defaultOptions, infra: 'none' });

    snapshotTreeDir(tree, 'packages/my-search/src');
    snapshotTreeDir(tree, 'packages/common/scripts/src/opensearch');
    expect(tree.exists('packages/common/constructs')).toBeFalsy();

    const projectJson = JSON.parse(
      tree.read('packages/my-search/project.json', 'utf-8'),
    );
    expect(projectJson.targets['pull-image']).toBeDefined();
    expect(projectJson.targets['dev']).toBeDefined();
    expect(projectJson.targets['sync-mappings']).toBeDefined();

    await tsOpenSearchGenerator(tree, defaultOptions);

    expect(tree.exists('packages/common/constructs')).toBeTruthy();
  });

  it('should be idempotent when re-run with same options', async () => {
    await tsOpenSearchGenerator(tree, defaultOptions);
    await tsOpenSearchGenerator(tree, defaultOptions);

    const projectConfig = readProjectConfigurationUnqualified(
      tree,
      '@proj/my-search',
    );
    expect((projectConfig.metadata as any).ports).toHaveLength(1);
    const buildDependsOn = projectConfig.targets['build'].dependsOn as any[];
    expect(buildDependsOn.filter((d) => d === 'sync-mappings')).toHaveLength(1);

    const sharedConstructsConfig = JSON.parse(
      tree.read('packages/common/constructs/project.json', 'utf-8') ?? '{}',
    );
    const buildDeps = sharedConstructsConfig.targets.build.dependsOn as any[];
    expect(buildDeps.filter((d) => d === '@proj/my-search:build')).toHaveLength(
      1,
    );
  });
});
