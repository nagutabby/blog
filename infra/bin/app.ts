import { App } from 'aws-cdk-lib';
import { BlogStack } from '../lib/blog-stack.js';
import { BlogCertificateStack } from '../lib/certificate-stack.js';

const app = new App();
const account = '444167236765';
const migrationPrepareValue = app.node.tryGetContext('blogMigrationPrepare');
const migrationPrepare = migrationPrepareValue === true || migrationPrepareValue === 'true';

const certificateStack = new BlogCertificateStack(app, 'BlogEdgeCertificate', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true
});
new BlogStack(app, 'Blog', {
  env: { account, region: 'ap-northeast-1' },
  crossRegionReferences: true,
  terminationProtection: !migrationPrepare,
  edgeCertificate: certificateStack.certificate,
  deployPublicEdge: !migrationPrepare
});
