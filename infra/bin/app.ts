import { App } from 'aws-cdk-lib';
import { BlogStack } from '../lib/blog-stack.js';
import { BlogCertificateStack } from '../lib/certificate-stack.js';

const app = new App();
const account = '444167236765';

const certificateStack = new BlogCertificateStack(app, 'SveltekitBlogEdgeCertificate', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true
});
new BlogStack(app, 'SveltekitBlog', {
  env: { account, region: 'ap-northeast-1' },
  crossRegionReferences: true,
  terminationProtection: true,
  edgeCertificate: certificateStack.certificate
});
