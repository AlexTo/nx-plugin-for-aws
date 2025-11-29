/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Tree } from '@nx/devkit';
import { createTreeUsingTsSolutionSetup } from './test';
import { resolveUiProvider } from './ui';
import {
  ensureAwsNxPluginConfig,
  updateAwsNxPluginConfig,
  AWS_NX_PLUGIN_CONFIG_FILE_NAME,
} from './config/utils';

describe('ui utils', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  describe('resolveUiProvider', () => {
    it('should return cloudscape when uiProviderOption is cloudscape', async () => {
      const result = await resolveUiProvider(tree, 'cloudscape');
      expect(result).toBe('cloudscape');
    });

    it('should return shadcn when uiProviderOption is shadcn', async () => {
      const result = await resolveUiProvider(tree, 'shadcn');
      expect(result).toBe('shadcn');
    });

    it('should resolve to cloudscape when uiProviderOption is Inherit and config has cloudscape provider', async () => {
      await ensureAwsNxPluginConfig(tree);
      await updateAwsNxPluginConfig(tree, {
        ui: {
          provider: 'cloudscape',
        },
      });

      const result = await resolveUiProvider(tree, 'Inherit');
      expect(result).toBe('cloudscape');
    });

    it('should resolve to shadcn when uiProviderOption is Inherit and config has shadcn provider', async () => {
      await ensureAwsNxPluginConfig(tree);
      await updateAwsNxPluginConfig(tree, {
        ui: {
          provider: 'shadcn',
        },
      });

      const result = await resolveUiProvider(tree, 'Inherit');
      expect(result).toBe('shadcn');
    });

    it('should throw error when uiProviderOption is Inherit but no config exists', async () => {
      await expect(resolveUiProvider(tree, 'Inherit')).rejects.toThrow(
        `UI provider "Inherit" requires ui.provider to be set in ${AWS_NX_PLUGIN_CONFIG_FILE_NAME}`,
      );
    });

    it('should throw error when uiProviderOption is Inherit but config has no ui.provider', async () => {
      await ensureAwsNxPluginConfig(tree);

      await expect(resolveUiProvider(tree, 'Inherit')).rejects.toThrow(
        `UI provider "Inherit" requires ui.provider to be set in ${AWS_NX_PLUGIN_CONFIG_FILE_NAME}`,
      );
    });

    it('should throw error when uiProviderOption is Inherit but config has invalid ui.provider', async () => {
      await ensureAwsNxPluginConfig(tree);
      await updateAwsNxPluginConfig(tree, {
        ui: {
          provider: 'InvalidProvider' as any,
        },
      });

      await expect(resolveUiProvider(tree, 'Inherit')).rejects.toThrow(
        `ui.provider in ${AWS_NX_PLUGIN_CONFIG_FILE_NAME} must be one of cloudscape, shadcn`,
      );
    });

    it('should throw error when uiProviderOption is Inherit but config has empty ui section', async () => {
      await ensureAwsNxPluginConfig(tree);
      await updateAwsNxPluginConfig(tree, {
        ui: {} as any,
      });

      await expect(resolveUiProvider(tree, 'Inherit')).rejects.toThrow(
        `UI provider "Inherit" requires ui.provider to be set in ${AWS_NX_PLUGIN_CONFIG_FILE_NAME}`,
      );
    });
  });
});
