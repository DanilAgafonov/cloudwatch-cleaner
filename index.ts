import "./aws-granted-workaround";

import { FunctionConfiguration, LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  LogGroup,
  DeleteLogGroupCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { CodeBuildClient, ListProjectsCommand } from "@aws-sdk/client-codebuild";
import Bottleneck from "bottleneck";

const lambdaClient = new LambdaClient({});
const cloudWatchLogsClient = new CloudWatchLogsClient({});
const codeBuildClient = new CodeBuildClient({});

async function getAllFunctions() {
  let nextMarker: string | undefined;

  const allFunctions: FunctionConfiguration[] = [];

  do {
    const { NextMarker, Functions } = await lambdaClient.send(
      new ListFunctionsCommand({
        MaxItems: 50,
        ...(nextMarker ? { Marker: nextMarker } : {}),
      }),
    );

    allFunctions.push(...Functions!);

    nextMarker = NextMarker;
  } while (nextMarker);

  return allFunctions;
}

async function getAllCodeBuildProjects() {
  let nextToken: string | undefined;

  const allProjects: string[] = [];

  do {
    const { nextToken: NextToken, projects } = await codeBuildClient.send(
      new ListProjectsCommand({
        ...(nextToken ? { nextToken } : {}),
      }),
    );

    allProjects.push(...projects!);

    nextToken = NextToken;
  } while (nextToken);

  return allProjects;
}

async function getAllLogGroups(prefix?: string) {
  let nextToken: string | undefined;

  const allLogGroups: LogGroup[] = [];

  do {
    const { nextToken: NextToken, logGroups } = await cloudWatchLogsClient.send(
      new DescribeLogGroupsCommand({
        limit: 50,
        ...(prefix ? { logGroupNamePrefix: prefix } : {}),
        ...(nextToken ? { nextToken } : {}),
      }),
    );

    allLogGroups.push(...logGroups!);

    nextToken = NextToken;
  } while (nextToken);

  return allLogGroups;
}

const MAX_DELETE_LOG_GROUP_RPS = 5;
const FUNCTION_LOG_GROUP_NAME_PREFIX = "/aws/lambda/";
const CODEBUILD_LOG_GROUP_NAME_PREFIX = "/aws/codebuild/";

console.log("Deleting log groups for orphaned functions");

const allFunctionsLogGroups = await getAllLogGroups(FUNCTION_LOG_GROUP_NAME_PREFIX);
const allFunctionsLogGroupsNames = new Set(allFunctionsLogGroups.map(({ logGroupName }) => logGroupName!));
const allFunctions = await getAllFunctions();
const allFunctionsNames = new Set(allFunctions.map(({ FunctionName }) => FunctionName!));

const functionsWithoutLogGroup = [...allFunctionsNames].filter(
  (fnName) => !allFunctionsLogGroupsNames.has(`${FUNCTION_LOG_GROUP_NAME_PREFIX}${fnName}`),
);

const orphanedLogGroupsForFunctions = [...allFunctionsLogGroupsNames].filter(
  (lgName) => !allFunctionsNames.has(lgName.slice(FUNCTION_LOG_GROUP_NAME_PREFIX.length)),
);

const deletedLogGroupsForFunctions: string[] = [];
const failedToDeleteLogGroupsForFunctions: string[] = [];

const deleteLogGroupForFunctionsFns = orphanedLogGroupsForFunctions.map(
  (lgName) => () =>
    cloudWatchLogsClient
      .send(new DeleteLogGroupCommand({ logGroupName: lgName }))
      .then(() => {
        deletedLogGroupsForFunctions.push(lgName);
        console.log(
          `(${deletedLogGroupsForFunctions.length}/${orphanedLogGroupsForFunctions.length}) "${lgName}" deleted`,
        );
      })
      .catch((err) => {
        console.log(`"${lgName}" failed to delete`);
        console.error(err);
        failedToDeleteLogGroupsForFunctions.push(lgName);
      }),
);

const deleteLogGroupsLimiter = new Bottleneck({
  minTime: 1000 / MAX_DELETE_LOG_GROUP_RPS,
});

const deleteLogGroupForFunctionsFnsWithLimit = deleteLogGroupForFunctionsFns.map((fn) =>
  deleteLogGroupsLimiter.wrap(fn),
);

await Promise.all(deleteLogGroupForFunctionsFnsWithLimit.map((fn) => fn()));

console.log({
  deletedLogGroupsForFunctionsCount: deletedLogGroupsForFunctions.length,
  failedToDeleteLogGroupsForFunctionsCount: failedToDeleteLogGroupsForFunctions.length,
  functionsWithoutLogGroup,
});

console.log("Deleting log groups for orphaned CodeBuild projects");

const allCodeBuildProjectsLogGroups = await getAllLogGroups(CODEBUILD_LOG_GROUP_NAME_PREFIX);
const allCodeBuildProjectsLogGroupsNames = new Set(
  allCodeBuildProjectsLogGroups.map(({ logGroupName }) => logGroupName!),
);
const allCodeBuildProjects = await getAllCodeBuildProjects();
const allCodeBuildProjectsNames = new Set(allCodeBuildProjects);

const orphanedLogGroupsForCodeBuildProjects = [...allCodeBuildProjectsLogGroupsNames].filter(
  (lgName) => !allCodeBuildProjectsNames.has(lgName.slice(CODEBUILD_LOG_GROUP_NAME_PREFIX.length)),
);

const deletedLogGroupsForCodeBuildProjects: string[] = [];
const failedToDeleteLogGroupsForCodeBuildProjects: string[] = [];

const deleteLogGroupForCodeBuildProjectsFns = orphanedLogGroupsForCodeBuildProjects.map(
  (lgName) => () =>
    cloudWatchLogsClient
      .send(new DeleteLogGroupCommand({ logGroupName: lgName }))
      .then(() => {
        deletedLogGroupsForCodeBuildProjects.push(lgName);
        console.log(
          `(${deletedLogGroupsForCodeBuildProjects.length}/${orphanedLogGroupsForCodeBuildProjects.length}) "${lgName}" deleted`,
        );
      })
      .catch((err) => {
        console.log(`"${lgName}" failed to delete`);
        console.error(err);
        failedToDeleteLogGroupsForCodeBuildProjects.push(lgName);
      }),
);

const deleteLogGroupForCodeBuildProjectsFnsWithLimit = deleteLogGroupForCodeBuildProjectsFns.map((fn) =>
  deleteLogGroupsLimiter.wrap(fn),
);

await Promise.all(deleteLogGroupForCodeBuildProjectsFnsWithLimit.map((fn) => fn()));

console.log({
  deletedLogGroupsForCodeBuildProjectsCount: deletedLogGroupsForCodeBuildProjects.length,
  failedToDeleteLogGroupsForCodeBuildProjectsCount: failedToDeleteLogGroupsForCodeBuildProjects.length,
});
