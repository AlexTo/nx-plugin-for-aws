/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Tree } from '@nx/devkit';
import {
  AWS_NX_PLUGIN_CONFIG_FILE_NAME,
  readAwsNxPluginConfig,
} from './config/utils';

export const UI_PROVIDERS = ['cloudscape', 'shadcn'] as const;

export type UiProvider = (typeof UI_PROVIDERS)[number];

export type UiProviderOption = UiProvider | 'Inherit';

export interface UiConfig {
  /**
   * Default UI provider for generated web apps
   */
  provider: UiProvider;
}

/**
 * Resolve a UI provider option to a concrete provider, allowing inheritance
 * from the workspace config.
 */
export const resolveUiProvider = async (
  tree: Tree,
  uiProviderOption: UiProviderOption,
): Promise<UiProvider> => {
  if (uiProviderOption === 'Inherit') {
    const pluginConfig = await readAwsNxPluginConfig(tree);

    if (!pluginConfig?.ui?.provider) {
      throw new Error(
        `UI provider "Inherit" requires ui.provider to be set in ${AWS_NX_PLUGIN_CONFIG_FILE_NAME}`,
      );
    }
    if (!UI_PROVIDERS.includes(pluginConfig.ui.provider)) {
      throw new Error(
        `ui.provider in ${AWS_NX_PLUGIN_CONFIG_FILE_NAME} must be one of ${UI_PROVIDERS.join(', ')}`,
      );
    }

    return pluginConfig.ui.provider;
  }
  return uiProviderOption;
};
