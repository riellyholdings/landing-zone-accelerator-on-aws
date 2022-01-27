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
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket } from '@aws-accelerator/constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { pascalCase } from 'change-case';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as yaml from 'js-yaml';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as cdk_extensions from '@aws-cdk-extensions/cdk-extensions';
import { CfnRepository } from 'aws-cdk-lib/aws-codecommit';
import { RemovalPolicy } from 'aws-cdk-lib';

/**
 * TesterPipelineProps
 */
export interface TesterPipelineProps {
  readonly qualifier: string;
  readonly sourceRepositoryName: string;
  readonly sourceBranchName: string;
  readonly managementCrossAccountRoleName: string;
  readonly managementAccountId?: string;
  readonly managementAccountRoleName?: string;
}

/**
 * AWS Accelerator Functional Test Pipeline Class, which creates the pipeline for Accelerator test
 */
export class TesterPipeline extends Construct {
  private readonly pipelineRole: iam.Role;
  private readonly deployOutput: codepipeline.Artifact;
  private readonly acceleratorRepoArtifact: codepipeline.Artifact;
  private readonly configRepoArtifact: codepipeline.Artifact;

  constructor(scope: Construct, id: string, props: TesterPipelineProps) {
    super(scope, id);

    let targetAcceleratorEnvVariables: { [p: string]: codebuild.BuildEnvironmentVariable } | undefined;

    const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'test-config-assets-'));
    fs.writeFileSync(path.join(tempDirPath, 'config.yaml'), yaml.dump({ tests: [] }), 'utf8');

    const configurationDefaultAssets = new s3_assets.Asset(this, 'ConfigurationDefaultAssets', {
      path: tempDirPath,
    });

    const configRepository = new cdk_extensions.Repository(this, 'ConfigRepository', {
      repositoryName: `${props.qualifier}-test-config`,
      repositoryBranchName: 'main',
      s3BucketName: configurationDefaultAssets.bucket.bucketName,
      s3key: configurationDefaultAssets.s3ObjectKey,
      description: 'AWS Accelerator functional test configuration repository',
    });

    const cfnRepository = configRepository.node.defaultChild as CfnRepository;
    cfnRepository.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });

    if (props.managementAccountId && props.managementAccountRoleName) {
      targetAcceleratorEnvVariables = {
        MANAGEMENT_ACCOUNT_ID: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: props.managementAccountId,
        },
        MANAGEMENT_ACCOUNT_ROLE_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: props.managementAccountRoleName,
        },
      };
    }

    const qualifierInPascalCase = pascalCase(props.qualifier)
      .split('_')
      .join('-')
      .replace(/AwsAccelerator/gi, 'AWSAccelerator');

    const bucket = new Bucket(this, 'SecureBucket', {
      s3BucketName: `${props.qualifier}-test-pipeline-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      kmsAliasName: `alias/${props.qualifier}/test-pipeline/s3`,
      kmsDescription: 'AWS Accelerator Functional Test Pipeline Bucket CMK',
    });

    // cfn_nag: Suppress warning related to the pipeline artifacts S3 bucket
    const cfnBucket = bucket.node.defaultChild?.node.defaultChild as s3.CfnBucket;
    cfnBucket.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W35',
            reason: 'S3 Bucket access logging is not enabled for the functional test pipeline artifacts bucket.',
          },
        ],
      },
    };

    /**
     * Functional test pipeline role
     */
    this.pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });

    /**
     * Functional test pipeline
     */
    const pipeline = new codepipeline.Pipeline(this, 'Resource', {
      pipelineName: `${qualifierInPascalCase}-TesterPipeline`,
      artifactBucket: bucket.getS3Bucket(),
      role: this.pipelineRole,
    });

    // cfn_nag: Suppress warning related to high SPCM score
    const cfnPipelinePolicy = pipeline.role.node.findChild('DefaultPolicy').node.defaultChild as iam.CfnPolicy;
    cfnPipelinePolicy.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W76',
            reason: 'This policy is generated by CDK which can cause a high SPCM score.',
          },
        ],
      },
    };

    this.configRepoArtifact = new codepipeline.Artifact('Config');
    this.acceleratorRepoArtifact = new codepipeline.Artifact('Source');

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.CodeCommitSourceAction({
          actionName: 'Source',
          repository: codecommit.Repository.fromRepositoryName(this, 'SourceRepo', props.sourceRepositoryName),
          branch: props.sourceBranchName,
          output: this.acceleratorRepoArtifact,
          trigger: codepipeline_actions.CodeCommitTrigger.NONE,
        }),
        new codepipeline_actions.CodeCommitSourceAction({
          actionName: 'Configuration',
          repository: configRepository,
          branch: 'main',
          output: this.configRepoArtifact,
          trigger: codepipeline_actions.CodeCommitTrigger.EVENTS,
        }),
      ],
    });

    /**
     * Deploy Stage
     */
    const deployRole = new iam.Role(this, 'DeployRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      //TODO restricted access
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    const testerProject = new codebuild.PipelineProject(this, 'TesterProject', {
      projectName: `${qualifierInPascalCase}-TesterProject`,
      role: deployRole,
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 14,
            },
          },
          build: {
            commands: [
              'cd source',
              'yarn install',
              'yarn lerna link',
              'yarn build',
              'cd packages/@aws-accelerator/tester',
              'env',
              `yarn run cdk deploy --require-approval never --context account=${cdk.Aws.ACCOUNT_ID} --context region=${cdk.Aws.REGION} --context management-cross-account-role-name=${props.managementCrossAccountRoleName} --context qualifier=${props.qualifier} --context config-dir=$CODEBUILD_SRC_DIR_Config`,
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true, // Allow access to the Docker daemon
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ACCELERATOR_REPOSITORY_NAME: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.sourceRepositoryName,
          },
          ACCELERATOR_REPOSITORY_BRANCH_NAME: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.sourceBranchName,
          },
          ...targetAcceleratorEnvVariables,
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
    });

    this.deployOutput = new codepipeline.Artifact('DeployOutput');

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Deploy',
          project: testerProject,
          input: this.acceleratorRepoArtifact,
          extraInputs: [this.configRepoArtifact],
          outputs: [this.deployOutput],
          role: this.pipelineRole,
        }),
      ],
    });
  }
}