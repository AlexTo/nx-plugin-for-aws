/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { ComponentMetadata } from '../../../utils/nx';

export interface TsOpenSearchMcpServerConnectionGeneratorSchema {
  sourceProject: string;
  targetProject: string;
  sourceComponent?: ComponentMetadata;
}
