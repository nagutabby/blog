import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  CfnOutput
} from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayLogs from 'aws-cdk-lib/aws-apigateway';
import { HttpApi, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin, HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

const account = '444167236765';
const appRegion = 'ap-northeast-1';
const edgeRegion = 'us-east-1';
const zoneId = 'Z08304752J8CINZWOOEB3';
const zoneName = 'app.nagutabby.uk';
const siteDomain = 'blog.app.nagutabby.uk';
const siteBaseURL = `https://${siteDomain}`;
const repoSubject = 'repo:nagutabby@62084485/blog@637631792:ref:refs/heads/main';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface BlogStackProps extends StackProps {
  edgeCertificate: import('aws-cdk-lib/aws-certificatemanager').ICertificate;
}

export class BlogStack extends Stack {
  constructor(scope: Construct, id: string, props: BlogStackProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'AppHostedZone', {
      hostedZoneId: zoneId,
      zoneName
    });

    const followerTable = new dynamodb.Table(this, 'Followers', {
      tableName: 'sveltekit-blog-followers',
      partitionKey: { name: 'actorId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN
    });
    followerTable.addGlobalSecondaryIndex({
      indexName: 'following-state-id-index',
      partitionKey: { name: 'state', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'orderKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const relayTable = new dynamodb.Table(this, 'RelayConnections', {
      tableName: 'sveltekit-blog-relay-connections',
      partitionKey: { name: 'actorId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN
    });
    relayTable.addGlobalSecondaryIndex({
      indexName: 'connected-state-id-index',
      partitionKey: { name: 'state', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'orderKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const runtimeSecret = new secretsmanager.Secret(this, 'RuntimeSecrets', {
      secretName: 'sveltekit-blog/runtime',
      description: 'Runtime keys and tokens for the blog APIs, including mail settings.',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'FEDERATION_ADMIN_TOKEN',
        passwordLength: 48,
        excludePunctuation: true
      },
      removalPolicy: RemovalPolicy.RETAIN
    });
    const originHeaderSecret = new secretsmanager.Secret(this, 'OriginHeaderSecret', {
      secretName: 'sveltekit-blog/cloudfront-origin-header',
      description: 'Shared origin header value used to reject direct API Gateway requests.',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true
      },
      removalPolicy: RemovalPolicy.RETAIN
    });

    const apiLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/sveltekit-blog',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const lambdaLogs = new logs.LogGroup(this, 'LambdaLogs', {
      logGroupName: '/aws/lambda/sveltekit-blog-api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const apiFunction = new NodejsFunction(this, 'BlogApiFunction', {
      functionName: 'sveltekit-blog-api',
      entry: path.join(repoRoot, 'web/src/worker/lambda.ts'),
      projectRoot: path.join(repoRoot, 'web'),
      depsLockFilePath: path.join(repoRoot, 'web/pnpm-lock.yaml'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 512,
      tracing: Tracing.ACTIVE,
      logGroup: lambdaLogs,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: []
      },
      environment: {
        SITE_BASE_URL: siteBaseURL,
        FOLLOWER_TABLE: followerTable.tableName,
        RELAY_TABLE: relayTable.tableName,
        RUNTIME_SECRET_ARN: runtimeSecret.secretArn,
        ORIGIN_HEADER_SECRET_ARN: originHeaderSecret.secretArn
      }
    });
    followerTable.grantReadWriteData(apiFunction);
    relayTable.grantReadWriteData(apiFunction);
    runtimeSecret.grantRead(apiFunction);
    originHeaderSecret.grantRead(apiFunction);

    const articleNotificationLogs = new logs.LogGroup(this, 'ArticleNotificationLambdaLogs', {
      logGroupName: '/aws/lambda/sveltekit-blog-article-notification',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const articleNotificationFunction = new NodejsFunction(this, 'ArticleNotificationFunction', {
      functionName: 'sveltekit-blog-article-notification',
      entry: path.join(repoRoot, 'web/src/worker/article-notification-lambda.ts'),
      projectRoot: path.join(repoRoot, 'web'),
      depsLockFilePath: path.join(repoRoot, 'web/pnpm-lock.yaml'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 512,
      tracing: Tracing.ACTIVE,
      logGroup: articleNotificationLogs,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: []
      },
      environment: {
        SITE_BASE_URL: siteBaseURL,
        FOLLOWER_TABLE: followerTable.tableName,
        RELAY_TABLE: relayTable.tableName,
        RUNTIME_SECRET_ARN: runtimeSecret.secretArn
      }
    });
    relayTable.grantReadData(articleNotificationFunction);
    runtimeSecret.grantRead(articleNotificationFunction);

    const httpApi = new HttpApi(this, 'BlogHttpApi', {
      apiName: 'sveltekit-blog-api',
      description: 'Blog API served through the CloudFront distribution.',
      createDefaultStage: false,
      defaultIntegration: new HttpLambdaIntegration('BlogLambdaIntegration', apiFunction)
    });
    new HttpStage(this, 'DefaultApiStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      detailedMetricsEnabled: true,
      accessLogSettings: {
        destination: new apigateway.LogGroupLogDestination(apiLogs),
        format: apigatewayLogs.AccessLogFormat.custom(JSON.stringify({
          requestId: apigatewayLogs.AccessLogField.contextRequestId(),
          sourceIp: apigatewayLogs.AccessLogField.contextIdentitySourceIp(),
          requestTime: apigatewayLogs.AccessLogField.contextRequestTime(),
          method: apigatewayLogs.AccessLogField.contextHttpMethod(),
          routeKey: apigatewayLogs.AccessLogField.contextRouteKey(),
          status: apigatewayLogs.AccessLogField.contextStatus(),
          protocol: apigatewayLogs.AccessLogField.contextProtocol(),
          responseLength: apigatewayLogs.AccessLogField.contextResponseLength()
        }))
      }
    });

    const articleNotificationHttpApi = new HttpApi(this, 'ArticleNotificationHttpApi', {
      apiName: 'sveltekit-blog-article-notifications',
      description: 'Bearer-token protected ActivityPub article notification endpoint.',
      createDefaultStage: false
    });
    new apigateway.HttpRoute(this, 'ArticleNotificationRoute', {
      httpApi: articleNotificationHttpApi,
      routeKey: apigateway.HttpRouteKey.with(
        '/rpc/federation-admin/publish-article-activity',
        apigateway.HttpMethod.POST
      ),
      integration: new HttpLambdaIntegration('ArticleNotificationIntegration', articleNotificationFunction)
    });
    const articleNotificationApiLogs = new logs.LogGroup(this, 'ArticleNotificationApiLogs', {
      logGroupName: '/aws/apigateway/sveltekit-blog-article-notifications',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN
    });
    new HttpStage(this, 'ArticleNotificationApiStage', {
      httpApi: articleNotificationHttpApi,
      stageName: '$default',
      autoDeploy: true,
      detailedMetricsEnabled: true,
      throttle: { burstLimit: 10, rateLimit: 5 },
      accessLogSettings: {
        destination: new apigateway.LogGroupLogDestination(articleNotificationApiLogs),
        format: apigatewayLogs.AccessLogFormat.custom(JSON.stringify({
          requestId: apigatewayLogs.AccessLogField.contextRequestId(),
          sourceIp: apigatewayLogs.AccessLogField.contextIdentitySourceIp(),
          requestTime: apigatewayLogs.AccessLogField.contextRequestTime(),
          method: apigatewayLogs.AccessLogField.contextHttpMethod(),
          routeKey: apigatewayLogs.AccessLogField.contextRouteKey(),
          status: apigatewayLogs.AccessLogField.contextStatus(),
          protocol: apigatewayLogs.AccessLogField.contextProtocol(),
          responseLength: apigatewayLogs.AccessLogField.contextResponseLength()
        }))
      }
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: 'sveltekit-blog-site-444167236765-ap-northeast-1',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const staticFunction = new cloudfront.Function(this, 'StaticUrlRewrite', {
      functionName: 'sveltekit-blog-static-url-rewrite',
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(repoRoot, 'web/src/worker/cloudfront/static-url-rewrite.js')
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Maps Astro clean URLs to its file-format HTML output.'
    });
    const blockInboxFunction = new cloudfront.Function(this, 'BlockInboxPost', {
      functionName: 'sveltekit-blog-block-inbox-post',
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(repoRoot, 'web/src/worker/cloudfront/block-inbox-post.js')
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Rejects all ActivityPub inbox POST requests.'
    });

    const apiOrigin = new HttpOrigin(`${httpApi.apiId}.execute-api.${appRegion}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: {
        'X-Blog-Origin-Verify': originHeaderSecret.secretValue.unsafeUnwrap()
      }
    });
    const apiBehavior = {
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
    };

    const distribution = new cloudfront.Distribution(this, 'BlogDistribution', {
      comment: 'Static blog and Hono API for blog.app.nagutabby.uk',
      domainNames: [siteDomain],
      certificate: props.edgeCertificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: cloudfront.SSLMethod.SNI,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: staticFunction
        }]
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.seconds(0) }
      ],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true
    });

    distribution.addBehavior('/actor/inbox', apiOrigin, {
      ...apiBehavior,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: blockInboxFunction
      }]
    });
    distribution.addBehavior('/rpc/*', apiOrigin, apiBehavior);
    distribution.addBehavior('/.well-known/*', apiOrigin, apiBehavior);
    distribution.addBehavior('/nodeinfo/*', apiOrigin, apiBehavior);
    distribution.addBehavior('/actor*', apiOrigin, apiBehavior);
    distribution.addBehavior('/api/articles/*', apiOrigin, apiBehavior);
    distribution.addBehavior('/healthz', apiOrigin, apiBehavior);

    new s3deploy.BucketDeployment(this, 'DeployStaticSite', {
      sources: [s3deploy.Source.asset(path.join(repoRoot, 'web/dist'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      retainOnDelete: true
    });

    new route53.ARecord(this, 'SiteAliasA', {
      zone: hostedZone,
      recordName: 'blog',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution))
    });
    new route53.AaaaRecord(this, 'SiteAliasAAAA', {
      zone: hostedZone,
      recordName: 'blog',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution))
    });

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubActionsOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com']
    });
    const deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: 'sveltekit-blog-github-deploy',
      description: 'Allows only pushes to the blog repository main branch to deploy with CDK.',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': repoSubject }
      }),
      maxSessionDuration: Duration.hours(1)
    });
    const bootstrapRoleArns = [appRegion, edgeRegion].flatMap((region) => [
      `arn:aws:iam::${account}:role/cdk-hnb659fds-deploy-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-hnb659fds-file-publishing-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-hnb659fds-lookup-role-${account}-${region}`
    ]);
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: bootstrapRoleArns
    }));

    new CfnOutput(this, 'SiteUrl', { value: siteBaseURL });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'ApiGatewayEndpoint', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'ArticleNotificationApiEndpoint', {
      value: `${articleNotificationHttpApi.apiEndpoint}/rpc/federation-admin/publish-article-activity`
    });
    new CfnOutput(this, 'RuntimeSecretArn', { value: runtimeSecret.secretArn });
    new CfnOutput(this, 'OriginHeaderSecretArn', { value: originHeaderSecret.secretArn });
    new CfnOutput(this, 'GitHubDeployRoleArn', { value: deployRole.roleArn });
  }
}
