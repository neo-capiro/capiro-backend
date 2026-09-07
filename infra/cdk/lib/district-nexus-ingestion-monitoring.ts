import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type { Construct } from 'constructs';

const NAMESPACE = 'Capiro/Ingestion';
const METRIC = 'district_nexus.error_count';

/** The four R4 jobs emit JSON through runWithSyncRun; all use the sync-jobs log group. */
export function addDistrictNexusIngestionErrorFilter(
  scope: Construct,
  logGroup: logs.ILogGroup,
): void {
  new logs.MetricFilter(scope, 'DistrictNexusIngestionErrorMetricFilter', {
    logGroup,
    metricNamespace: NAMESPACE,
    metricName: METRIC,
    filterPattern: logs.FilterPattern.literal(
      '{ ($.event = "INGESTION_METRIC") && (($.source = "sync-district-economic-*") || ($.source = "sync-tango-subawards*")) && ($.error_count = *) }',
    ),
    metricValue: '$.error_count',
    defaultValue: 0,
  });
}

/** A monthly job cannot supply errors in two consecutive hourly windows. */
export function districtNexusIngestionErrorAlarm(
  scope: Construct,
  envName: string,
): cloudwatch.Alarm {
  return new cloudwatch.Alarm(scope, 'DistrictNexusIngestionErrorAlarm', {
    alarmName: `capiro-${envName}-district-nexus-ingestion-error`,
    alarmDescription: 'A District Nexus ACS, CBP, LODES or Tango run reported an error',
    metric: new cloudwatch.Metric({
      namespace: NAMESPACE,
      metricName: METRIC,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    }),
    threshold: 0,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
