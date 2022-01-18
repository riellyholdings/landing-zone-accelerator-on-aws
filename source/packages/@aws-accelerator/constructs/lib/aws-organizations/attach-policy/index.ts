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

import { throttlingBackOff } from '@aws-accelerator/utils';
import {
  AttachPolicyCommand,
  DetachPolicyCommand,
  OrganizationsClient,
  paginateListPoliciesForTarget,
} from '@aws-sdk/client-organizations';

/**
 * attach-policy - lambda handler
 *
 * @param event
 * @returns
 */
export async function handler(event: AWSLambda.CloudFormationCustomResourceEvent): Promise<
  | {
      PhysicalResourceId: string | undefined;
      Status: string;
    }
  | undefined
> {
  const policyId: string = event.ResourceProperties['policyId'];
  const targetId: string = event.ResourceProperties['targetId'] ?? undefined;
  const type: string = event.ResourceProperties['type'];

  const organizationsClient = new OrganizationsClient({});

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      //
      // Check if already exists, update and return the ID
      //
      for await (const page of paginateListPoliciesForTarget(
        { client: organizationsClient },
        { Filter: type, TargetId: targetId },
      )) {
        for (const policy of page.Policies ?? []) {
          if (policy.Id === policyId) {
            console.log('Policy already attached');
            return {
              PhysicalResourceId: `${policyId}_${targetId}`,
              Status: 'SUCCESS',
            };
          }
        }
      }

      //
      // Create if not found
      //
      await throttlingBackOff(() =>
        organizationsClient.send(
          new AttachPolicyCommand({
            PolicyId: policyId,
            TargetId: targetId,
          }),
        ),
      );

      return {
        PhysicalResourceId: `${policyId}_${targetId}`,
        Status: 'SUCCESS',
      };

    case 'Delete':
      //
      // Detach policy, let CDK manage where it's deployed,
      //

      // do not remove FullAWSAccess
      if (policyId !== 'p-FullAWSAccess') {
        // Find the specific policy
        for await (const page of paginateListPoliciesForTarget(
          { client: organizationsClient },
          { Filter: type, TargetId: targetId },
        )) {
          for (const policy of page.Policies ?? []) {
            if (policy.Id === policyId) {
              await throttlingBackOff(() =>
                organizationsClient.send(
                  new DetachPolicyCommand({
                    PolicyId: policyId,
                    TargetId: targetId,
                  }),
                ),
              );
            }
          }
        }
      }

      return {
        PhysicalResourceId: event.PhysicalResourceId,
        Status: 'SUCCESS',
      };
  }
}