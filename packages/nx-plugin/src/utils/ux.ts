/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

export const UX_PROVIDERS = ['None', 'Cloudscape', 'Shadcn'] as const;

export type UxProviderOption = (typeof UX_PROVIDERS)[number];
