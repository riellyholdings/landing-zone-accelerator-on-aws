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

import * as cdk from 'aws-cdk-lib';
import { v4 as uuidv4 } from 'uuid';
import { Construct } from 'constructs';

const path = require('path');

/**
 * Initialized AwsMacieMembersProps properties
 */
export interface AwsMacieMembersProps {
  readonly region: string;
  readonly adminAccountId: string;
}

/**
 /**
 * Class to Aws MacieSession Members
 */
export class MacieMembers extends Construct {
  public readonly id: string;

  constructor(scope: Construct, id: string, props: AwsMacieMembersProps) {
    super(scope, id);

    const MACIE_RESOURCE_TYPE = 'Custom::MacieCreateMember';

    const addMembersFunction = cdk.CustomResourceProvider.getOrCreateProvider(this, MACIE_RESOURCE_TYPE, {
      codeDirectory: path.join(__dirname, 'create-member/dist'),
      runtime: cdk.CustomResourceProviderRuntime.NODEJS_14_X,
      policyStatements: [
        {
          Sid: 'MacieCreateMemberTaskOrganizationAction',
          Effect: 'Allow',
          Action: ['organizations:ListAccounts'],
          Resource: '*',
          Condition: {
            StringLikeIfExists: {
              'organizations:ListAccounts': ['macie.amazonaws.com'],
            },
          },
        },
        {
          Sid: 'MacieCreateMemberTaskMacieActions',
          Effect: 'Allow',
          Action: [
            'macie2:CreateMember',
            'macie2:DeleteMember',
            'macie2:DescribeOrganizationConfiguration',
            'macie2:DisassociateMember',
            'macie2:EnableMacie',
            'macie2:GetMacieSession',
            'macie2:ListMembers',
            'macie2:UpdateOrganizationConfiguration',
          ],
          Resource: '*',
        },
      ],
    });

    const resource = new cdk.CustomResource(this, 'Resource', {
      resourceType: MACIE_RESOURCE_TYPE,
      serviceToken: addMembersFunction.serviceToken,
      properties: {
        region: props.region,
        adminAccountId: props.adminAccountId,
        uuid: uuidv4(), // Generates a new UUID to force the resource to update
      },
    });

    this.id = resource.ref;
  }
}