import { Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

const zoneId = 'Z08304752J8CINZWOOEB3';
const zoneName = 'app.nagutabby.uk';
const siteDomain = 'blog.app.nagutabby.uk';

export class BlogCertificateStack extends Stack {
  readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'AppHostedZone', {
      hostedZoneId: zoneId,
      zoneName
    });
    this.certificate = new acm.Certificate(this, 'BlogCertificate', {
      domainName: siteDomain,
      validation: acm.CertificateValidation.fromDns(zone)
    });
  }
}
