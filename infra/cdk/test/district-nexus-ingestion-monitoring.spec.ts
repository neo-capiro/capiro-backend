import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Template } from 'aws-cdk-lib/assertions';
import {
  addDistrictNexusIngestionErrorFilter,
  districtNexusIngestionErrorAlarm,
} from '../lib/district-nexus-ingestion-monitoring';

test('one failed monthly run creates a breaching alarm datapoint on the metric produced by the log filter', () => {
  const stack = new cdk.Stack();
  const logGroup = new logs.LogGroup(stack, 'SyncLogs');
  addDistrictNexusIngestionErrorFilter(stack, logGroup);
  districtNexusIngestionErrorAlarm(stack, 'dev');
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    MetricTransformations: [
      {
        MetricNamespace: 'Capiro/Ingestion',
        MetricName: 'district_nexus.error_count',
        MetricValue: '$.error_count',
        DefaultValue: 0,
      },
    ],
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'capiro-dev-district-nexus-ingestion-error',
    Namespace: 'Capiro/Ingestion',
    MetricName: 'district_nexus.error_count',
    EvaluationPeriods: 1,
    DatapointsToAlarm: 1,
    Threshold: 0,
    ComparisonOperator: 'GreaterThanThreshold',
    TreatMissingData: 'notBreaching',
  });
  template.resourceCountIs('AWS::Events::Rule', 0);
});
