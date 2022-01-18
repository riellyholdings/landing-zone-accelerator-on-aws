/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as cdk from 'aws-cdk-lib';
import { v4 as uuidv4 } from 'uuid';
import { Construct } from 'constructs';

const path = require('path');

export enum PolicyType {
  AISERVICES_OPT_OUT_POLICY = 'AISERVICES_OPT_OUT_POLICY',
  BACKUP_POLICY = 'BACKUP_POLICY',
  SERVICE_CONTROL_POLICY = 'SERVICE_CONTROL_POLICY',
  TAG_POLICY = 'TAG_POLICY',
}

/**
 * <p>A custom key-value pair associated with a resource within your organization.</p>
 *         <p>You can attach tags to any of the following organization resources.</p>
 *         <ul>
 *             <li>
 *                 <p>AWS account</p>
 *             </li>
 *             <li>
 *                 <p>Organizational unit (OU)</p>
 *             </li>
 *             <li>
 *                 <p>Organization root</p>
 *             </li>
 *             <li>
 *                 <p>Policy</p>
 *             </li>
 *          </ul>
 */
export interface Tag {
  /**
   * <p>The key identifier, or name, of the tag.</p>
   */
  Key: string | undefined;

  /**
   * <p>The string value that's associated with the key of the tag. You can set the value of a
   *             tag to an empty string, but you can't set the value of a tag to null.</p>
   */
  Value: string | undefined;
}

/**
 * Initialized Policy properties
 */
export interface PolicyProps {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly type: PolicyType;
  readonly tags?: Tag[];
}

/**
 * Class to initialize Policy
 */
export class Policy extends Construct {
  public readonly id: string;
  public readonly path: string;
  public readonly name: string;
  public readonly description?: string;
  public readonly type: PolicyType;
  public readonly tags?: Tag[];

  constructor(scope: Construct, id: string, props: PolicyProps) {
    super(scope, id);

    this.path = props.path;
    this.name = props.name;
    this.description = props.description || '';
    this.type = props.type;
    this.tags = props.tags || [];

    //
    // Bundle the policy file. This will be available as an asset in S3
    //
    const asset = new assets.Asset(this, 'Policy', {
      path: props.path,
    });

    //
    // Function definition for the custom resource
    //
    const createPolicyFunction = cdk.CustomResourceProvider.getOrCreateProvider(
      this,
      'Custom::OrganizationsCreatePolicy',
      {
        codeDirectory: path.join(__dirname, 'create-policy/dist'),
        runtime: cdk.CustomResourceProviderRuntime.NODEJS_14_X,
        policyStatements: [
          {
            Effect: 'Allow',
            Action: ['organizations:CreatePolicy', 'organizations:ListPolicies', 'organizations:UpdatePolicy'],
            Resource: '*',
          },
          {
            Effect: 'Allow',
            Action: ['s3:GetObject'],
            Resource: cdk.Stack.of(this).formatArn({
              service: 's3',
              region: '',
              account: '',
              resource: asset.s3BucketName,
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: '*',
            }),
          },
        ],
      },
    );

    //
    // Custom Resource definition. We want this resource to be evaluated on
    // every CloudFormation update, so we generate a new uuid to force
    // re-evaluation.
    //
    const resource = new cdk.CustomResource(this, 'Resource', {
      resourceType: 'Custom::CreatePolicy',
      serviceToken: createPolicyFunction.serviceToken,
      properties: {
        bucket: asset.s3BucketName,
        key: asset.s3ObjectKey,
        uuid: uuidv4(),
        ...props,
      },
    });

    this.id = resource.ref;
  }
}