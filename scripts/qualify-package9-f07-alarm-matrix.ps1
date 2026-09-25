[CmdletBinding()]
param(
  [string]$Region = 'us-east-1',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$qualificationPath = Join-Path $PSScriptRoot '..\docs\defense-budget\package-9\failure-recovery-qualification.json'
$budgetPath = Join-Path $PSScriptRoot '..\docs\defense-budget\package-0\operating-budgets.v1.json'
$qualification = Get-Content -Raw $qualificationPath | ConvertFrom-Json
$budget = Get-Content -Raw $budgetPath | ConvertFrom-Json

# Warning thresholds come from the operator runbook; stop thresholds come from Package 9 hard limits.
$runbookSource = 'docs/defense-budget/package-9/operator-runbook.md#alarm-policy'
$matrix = @(
  [ordered]@{ id = 'pending-outbox-warning'; signal = 'pending-outbox'; phase = 'warning'; label = 'Pending outbox rows'; limit = 80.0; breachValue = 80.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Count'; source = $runbookSource },
  [ordered]@{ id = 'pending-outbox-stop'; signal = 'pending-outbox'; phase = 'stop'; label = 'Pending outbox rows'; limit = [double]$qualification.hardLimits.peakPendingOutboxRows; breachValue = [double]$qualification.hardLimits.peakPendingOutboxRows; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Count'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/peakPendingOutboxRows' },
  [ordered]@{ id = 'dead-letter-warning'; signal = 'dead-letter'; phase = 'warning'; label = 'Dead-letter rows'; limit = 8.0; breachValue = 8.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Count'; source = $runbookSource },
  [ordered]@{ id = 'dead-letter-stop'; signal = 'dead-letter'; phase = 'stop'; label = 'Dead-letter rows'; limit = [double]$qualification.hardLimits.deadLetterRows; breachValue = [double]$qualification.hardLimits.deadLetterRows; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Count'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/deadLetterRows' },
  [ordered]@{ id = 'oldest-pending-age-warning'; signal = 'oldest-pending-age'; phase = 'warning'; label = 'Oldest pending age (minutes)'; limit = 45.0; breachValue = 45.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = $runbookSource },
  [ordered]@{ id = 'oldest-pending-age-stop'; signal = 'oldest-pending-age'; phase = 'stop'; label = 'Oldest pending age (minutes)'; limit = [double]$qualification.hardLimits.oldestPendingAgeMinutes; breachValue = [double]$qualification.hardLimits.oldestPendingAgeMinutes; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/oldestPendingAgeMinutes' },
  [ordered]@{ id = 'drain-task-count-warning'; signal = 'drain-task-count'; phase = 'warning'; label = 'Concurrent drain tasks'; limit = 3.0; breachValue = 3.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Count'; source = $runbookSource },
  [ordered]@{ id = 'drain-task-count-stop'; signal = 'drain-task-count'; phase = 'stop'; label = 'Concurrent drain tasks'; limit = [double]$qualification.hardLimits.concurrentDrainTasks; breachValue = [double]$qualification.hardLimits.concurrentDrainTasks; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Count'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/concurrentDrainTasks' },
  [ordered]@{ id = 'drain-task-runtime-warning'; signal = 'drain-task-runtime'; phase = 'warning'; label = 'Drain task runtime (minutes)'; limit = 25.0; breachValue = 25.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = $runbookSource },
  [ordered]@{ id = 'drain-task-runtime-stop'; signal = 'drain-task-runtime'; phase = 'stop'; label = 'Drain task runtime (minutes)'; limit = [double]$qualification.hardLimits.maxDrainTaskRuntimeMinutes; breachValue = [double]$qualification.hardLimits.maxDrainTaskRuntimeMinutes; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/maxDrainTaskRuntimeMinutes' },
  [ordered]@{ id = 'interactive-query-p95-warning'; signal = 'interactive-query-p95'; phase = 'warning'; label = 'Interactive query p95 (milliseconds)'; limit = 1600.0; breachValue = 1600.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Milliseconds'; source = $runbookSource },
  [ordered]@{ id = 'interactive-query-p95-stop'; signal = 'interactive-query-p95'; phase = 'stop'; label = 'Interactive query p95 (milliseconds)'; limit = [double]$qualification.hardLimits.commonInteractiveQueryP95Milliseconds; breachValue = [double]$qualification.hardLimits.commonInteractiveQueryP95Milliseconds; operator = 'GreaterThanOrEqualToThreshold'; unit = 'Milliseconds'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/commonInteractiveQueryP95Milliseconds' },
  [ordered]@{ id = 'verified-update-p95-warning'; signal = 'verified-update-p95'; phase = 'warning'; label = 'Verified program update p95 (minutes)'; limit = 45.0; breachValue = 45.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = $runbookSource },
  [ordered]@{ id = 'verified-update-p95-stop'; signal = 'verified-update-p95'; phase = 'stop'; label = 'Verified program update p95 (minutes)'; limit = [double]$budget.peakReleaseDay.verifiedProgramUpdateP95Minutes; breachValue = [double]$budget.peakReleaseDay.verifiedProgramUpdateP95Minutes; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = 'docs/defense-budget/package-0/operating-budgets.v1.json#/peakReleaseDay/verifiedProgramUpdateP95Minutes' },
  [ordered]@{ id = 'aws-annual-cost-warning'; signal = 'aws-annual-cost'; phase = 'warning'; label = 'Incremental AWS annual projection (USD)'; limit = 800.0; breachValue = 800.0; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = $runbookSource },
  [ordered]@{ id = 'aws-annual-cost-stop'; signal = 'aws-annual-cost'; phase = 'stop'; label = 'Incremental AWS annual projection (USD)'; limit = [double]$qualification.hardLimits.incrementalAwsAnnualUsd; breachValue = [double]$qualification.hardLimits.incrementalAwsAnnualUsd; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/incrementalAwsAnnualUsd' },
  [ordered]@{ id = 'provider-unauthorized-spend-warning'; signal = 'provider-spend'; phase = 'warning'; label = 'Unauthorized paid provider spend (USD)'; limit = 0.0; breachValue = 0.01; operator = 'GreaterThanThreshold'; unit = 'None'; source = $runbookSource },
  [ordered]@{ id = 'provider-annual-cost-stop'; signal = 'provider-spend'; phase = 'stop'; label = 'Paid provider annual cost (USD)'; limit = [double]$qualification.hardLimits.paidProviderAnnualUsd; breachValue = [double]$qualification.hardLimits.paidProviderAnnualUsd; operator = 'GreaterThanOrEqualToThreshold'; unit = 'None'; source = 'docs/defense-budget/package-9/failure-recovery-qualification.json#/hardLimits/paidProviderAnnualUsd' }
)
$syntheticDeliveryWindowSeconds = 600

$required = @(
  'peakPendingOutboxRows', 'deadLetterRows', 'oldestPendingAgeMinutes',
  'concurrentDrainTasks', 'maxDrainTaskRuntimeMinutes',
  'commonInteractiveQueryP95Milliseconds', 'incrementalAwsAnnualUsd',
  'paidProviderAnnualUsd', 'defaultPaidProviderBudgetUsd'
)
foreach ($name in $required) {
  if ($null -eq $qualification.hardLimits.$name) { throw "Missing Package 9 hard limit: $name" }
}
if ($null -eq $budget.peakReleaseDay.verifiedProgramUpdateP95Minutes) {
  throw 'Missing Package 0 verifiedProgramUpdateP95Minutes limit'
}
$matrixIds = @($matrix | ForEach-Object { $_.id })
if ($matrix.Count -ne 18 -or @($matrixIds | Select-Object -Unique).Count -ne $matrix.Count) {
  throw 'Threshold matrix must contain eighteen unique warning/stop threshold identities'
}
$invalidRows = @($matrix | Where-Object {
  $_.limit -lt 0 -or
  ($_.operator -eq 'GreaterThanThreshold' -and $_.breachValue -le $_.limit) -or
  ($_.operator -eq 'GreaterThanOrEqualToThreshold' -and $_.breachValue -lt $_.limit)
})
if ($invalidRows.Count -ne 0) {
  throw "Every matrix row must have a nonnegative limit and a breach value above it; invalid: $(($invalidRows | ForEach-Object { $_.id + '=' + $_.limit + '=>' + $_.breachValue }) -join ', ')"
}

$matrixReport = @($matrix | ForEach-Object {
  [ordered]@{
    id = $_.id
    label = $_.label
    threshold = $_.limit
    breachValue = $_.breachValue
    comparisonOperator = $_.operator
    unit = $_.unit
    phase = $_.phase
    signal = $_.signal
    thresholdClass = $_.phase
    source = $_.source
  }
})
if ($DryRun) {
  [ordered]@{
    result = 'CONFIG_VALID'
    region = $Region
    matrixCount = $matrix.Count
    syntheticDeliveryWindowSeconds = $syntheticDeliveryWindowSeconds
    deliveryWindowBasis = 'Harness-only limit; no numeric delivery window is declared by the runbook.'
    configuredDefaultProviderAllocationUsd = [double]$qualification.hardLimits.defaultPaidProviderBudgetUsd
    thresholds = $matrixReport
    humanAcknowledgement = 'NOT_RUN'
    stopAdmission = 'NOT_RUN'
    evidencePreservation = 'NOT_RUN'
    note = 'Warning and stop thresholds use the operator runbook and declared hard limits. Provider unauthorized spend is tested above the $0 default allocation; the harness delivery-window limit is not a runbook value.'
  } | ConvertTo-Json -Depth 8
  exit 0
}

$ErrorActionPreference = 'Stop'
$runKey = 'p9-f07-matrix-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$topicName = "$runKey-topic"
$queueName = "$runKey-receiver"
$namespace = "Capiro/Package9/F07/$runKey"
$topicArn = $null
$queueUrl = $null
$queueArn = $null
$subscriptionArn = $null
$identity = $null
$alarms = @{}
$createdAlarmNames = [System.Collections.Generic.List[string]]::new()
$delivered = @{}
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$result = [ordered]@{
  schemaVersion = 2
  scenario = 'P9-F07-ALARM-DELIVERY'
  runKey = $runKey
  region = $Region
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  completedAt = $null
  callerArn = $null
  namespace = $namespace
  thresholds = $matrixReport
  syntheticDeliveryWindowSeconds = $syntheticDeliveryWindowSeconds
  deliveryWindowBasis = 'Harness-only limit; no numeric delivery window is declared by the runbook.'
  configuredDefaultProviderAllocationUsd = [double]$qualification.hardLimits.defaultPaidProviderBudgetUsd
  resources = [ordered]@{}
  observations = [System.Collections.Generic.List[object]]::new()
  cleanup = [ordered]@{}
  humanAcknowledgement = 'NOT_RUN'
  stopAdmission = 'NOT_RUN'
  evidencePreservation = 'NOT_RUN'
  result = 'RUNNING'
  limitation = 'Synthetic metric alarm transitions and isolated receiver delivery only. No human acknowledgement, stop-admission, or evidence-preservation action was run.'
}

function Invoke-AwsCli([string[]]$Arguments) {
  $output = & aws.exe @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "aws $($Arguments -join ' ') failed: $($output -join "`n")" }
  return ($output -join "`n")
}
function Add-Observation([string]$Phase, [string]$State, [string]$Detail, [object]$Extra = $null) {
  $row = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); phase = $Phase; state = $State; detail = $Detail }
  if ($null -ne $Extra) { foreach ($property in $Extra.PSObject.Properties) { $row[$property.Name] = $property.Value } }
  $result.observations.Add($row)
  Write-Output "[$((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))] $Phase $State $Detail"
}
function Get-AlarmName($Entry) { return "$runKey-$($Entry.id)" }
function Format-Number([double]$Value) { return $Value.ToString('G', [Globalization.CultureInfo]::InvariantCulture) }
function Wait-AlarmState([string]$Name, [string]$Desired) {
  $deadline = (Get-Date).AddSeconds(420)
  do {
    $state = (Invoke-AwsCli @('cloudwatch','describe-alarms','--region',$Region,'--alarm-names',$Name,'--query','MetricAlarms[0].StateValue','--output','text')).Trim()
    if ($state -eq $Desired) { return (Get-AlarmTransitionTime $Name $Desired) }
    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Name to enter $Desired"
}
function Get-AlarmTransitionTime([string]$Name, [string]$Desired) {
  $deadline = (Get-Date).AddSeconds(60)
  do {
    $history = Invoke-AwsCli @('cloudwatch','describe-alarm-history','--region',$Region,'--alarm-name',$Name,'--history-item-type','StateUpdate','--max-records','10','--output','json') | ConvertFrom-Json
    $matches = @()
    foreach ($item in @($history.AlarmHistoryItems)) {
      $data = $item.HistoryData | ConvertFrom-Json
      if ($data.newState.stateValue -eq $Desired) { $matches += $item }
    }
    if ($matches.Count -gt 0) {
      $latest = $matches | Sort-Object { [DateTimeOffset]::Parse([string]$_.Timestamp) } -Descending | Select-Object -First 1
      return [DateTimeOffset]::Parse([string]$latest.Timestamp).ToUniversalTime()
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "No CloudWatch StateUpdate timestamp found for $Name entering $Desired"
}
function Assert-MessageIdentity($AlarmMessage) {
  $matched = @($matrix | Where-Object { (Get-AlarmName $_) -eq $AlarmMessage.AlarmName })
  if ($matched.Count -ne 1) { throw "Received unknown alarm identity: $($AlarmMessage.AlarmName)" }
  $entry = $matched[0]
  $dims = @($AlarmMessage.Trigger.Dimensions)
  if ($AlarmMessage.Trigger.Namespace -ne $namespace -or $AlarmMessage.Trigger.MetricName -ne "P9F07_$($entry.id)" -or $dims.Count -ne 1 -or $dims[0].Name -ne 'ThresholdId' -or $dims[0].Value -ne $entry.id) {
    throw "Notification metric identity mismatch for $($AlarmMessage.AlarmName)"
  }
  if ($AlarmMessage.AlarmArn -ne $alarms[$entry.id].Arn) { throw "Notification ARN mismatch for $($entry.id)" }
  return $entry
}
function Receive-OneState($Entry, [string]$DesiredState, [DateTimeOffset]$TransitionTime) {
  $expected = "$($Entry.id)|$DesiredState"
  $deadline = (Get-Date).AddSeconds(600)
  while (-not $delivered.ContainsKey($expected) -and (Get-Date) -lt $deadline) {
    $raw = Invoke-AwsCli @('sqs','receive-message','--region',$Region,'--queue-url',$queueUrl,'--wait-time-seconds','20','--max-number-of-messages','10','--attribute-names','All','--output','json')
    $batch = $raw | ConvertFrom-Json
    $messages = @()
    if ($null -ne $batch -and $null -ne $batch.Messages) { $messages = @($batch.Messages) }
    foreach ($message in $messages) {
      $sns = $message.Body | ConvertFrom-Json
      $alarmMessage = $sns.Message | ConvertFrom-Json
      $entry = Assert-MessageIdentity $alarmMessage
      if ($entry.id -ne $Entry.id) { throw "Received $($entry.id) while waiting for $($Entry.id) $DesiredState" }
      if ($alarmMessage.NewStateValue -ne $DesiredState) { throw "Unexpected $($alarmMessage.NewStateValue) notification for $($entry.id), expected $DesiredState" }
      $observedAt = [DateTimeOffset]::UtcNow
      $elapsedSeconds = ($observedAt - $TransitionTime).TotalSeconds
      if ($elapsedSeconds -lt 0) { throw "CloudWatch transition timestamp is in the future for $($entry.id) $DesiredState" }
      if ($elapsedSeconds -gt $syntheticDeliveryWindowSeconds) { throw "Delivery for $($entry.id) $DesiredState exceeded harness limit ${syntheticDeliveryWindowSeconds}s (${elapsedSeconds}s)" }
      Invoke-AwsCli @('sqs','delete-message','--region',$Region,'--queue-url',$queueUrl,'--receipt-handle',$message.ReceiptHandle) | Out-Null
      $acknowledgedAt = [DateTimeOffset]::UtcNow
      $elapsedSeconds = ($acknowledgedAt - $TransitionTime).TotalSeconds
      if ($elapsedSeconds -gt $syntheticDeliveryWindowSeconds) { throw "Acknowledgement for $($entry.id) $DesiredState exceeded harness limit ${syntheticDeliveryWindowSeconds}s (${elapsedSeconds}s)" }
      $key = "$($entry.id)|$DesiredState"
      $delivered[$key] = $true
      Add-Observation 'delivery' $DesiredState "Acknowledged isolated notification for $($entry.id) within harness limit" ([pscustomobject]@{ alarmName = $alarmMessage.AlarmName; alarmArn = $alarmMessage.AlarmArn; metricName = $alarmMessage.Trigger.MetricName; snsMessageId = $sns.MessageId; sqsMessageId = $message.MessageId; cloudWatchTransitionAt = $TransitionTime.ToString('o'); acknowledgedAt = $acknowledgedAt.ToString('o'); elapsedSeconds = [math]::Round($elapsedSeconds,3); deliveryWindowLimitSeconds = $syntheticDeliveryWindowSeconds; deliveryWindowBasis = 'Harness-only limit; no numeric delivery window is declared by the runbook.' })
    }
  }
  if (-not $delivered.ContainsKey($expected)) { throw "Missing $DesiredState delivery: $expected" }
}
function Clear-AndVerifyQueue {
  $empty = 0
  $extra = 0
  while ($empty -lt 2) {
    $raw = Invoke-AwsCli @('sqs','receive-message','--region',$Region,'--queue-url',$queueUrl,'--wait-time-seconds','2','--max-number-of-messages','10','--output','json')
    $batch = $raw | ConvertFrom-Json
    $messages = @()
    if ($null -ne $batch -and $null -ne $batch.Messages) { $messages = @($batch.Messages) }
    if ($messages.Count -eq 0) { $empty++; continue }
    $empty = 0
    foreach ($message in $messages) {
      $sns = $message.Body | ConvertFrom-Json
      $alarmMessage = $sns.Message | ConvertFrom-Json
      $entry = Assert-MessageIdentity $alarmMessage
      if ($alarmMessage.NewStateValue -notin @('ALARM','OK') -or -not $delivered.ContainsKey("$($entry.id)|$($alarmMessage.NewStateValue)")) { throw "Unexpected queued state while draining: $($entry.id) $($alarmMessage.NewStateValue)" }
      Invoke-AwsCli @('sqs','delete-message','--region',$Region,'--queue-url',$queueUrl,'--receipt-handle',$message.ReceiptHandle) | Out-Null
      $extra++
    }
    if ($extra -gt 100) { throw 'Unexpected duplicate delivery volume' }
  }
  Add-Observation 'ack-verification' 'PASS' "Two consecutive empty receives after acknowledging $extra duplicate deliveries" ([pscustomobject]@{ consecutiveEmptyReceives = 2; duplicateDeliveries = $extra })
}

try {
  $identity = Invoke-AwsCli @('sts','get-caller-identity','--output','json') | ConvertFrom-Json
  $result.callerArn = $identity.Arn
  Add-Observation 'preflight' 'PASS' 'AWS identity recorded; all resource names are run-unique'
  $existing = Invoke-AwsCli @('cloudwatch','describe-alarms','--region',$Region,'--alarm-name-prefix',$runKey,'--query','length(MetricAlarms)','--output','text')
  if ($existing.Trim() -ne '0') { throw 'Generated alarm prefix already exists' }
  $existingTopics = Invoke-AwsCli @('sns','list-topics','--region',$Region,'--query',"length(Topics[?ends_with(TopicArn, ':$topicName')])",'--output','text')
  if ($existingTopics.Trim() -ne '0') { throw 'Generated SNS topic name already exists' }
  $queuePreflight = & aws.exe sqs get-queue-url --region $Region --queue-name $queueName --output json 2>&1
  $queuePreflightCode = $LASTEXITCODE
  if ($queuePreflightCode -eq 0) { throw 'Generated SQS queue name already exists' }
  if (($queuePreflight -join "`n") -notmatch 'NonExistentQueue') { throw "Could not prove generated queue name absent: $($queuePreflight -join "`n")" }
  $topicArn = (Invoke-AwsCli @('sns','create-topic','--region',$Region,'--name',$topicName,'--query','TopicArn','--output','text')).Trim()
  $queueUrl = (Invoke-AwsCli @('sqs','create-queue','--region',$Region,'--queue-name',$queueName,'--attributes','SqsManagedSseEnabled=true','--query','QueueUrl','--output','text')).Trim()
  $queueAttributesReadback = Invoke-AwsCli @('sqs','get-queue-attributes','--region',$Region,'--queue-url',$queueUrl,'--attribute-names','QueueArn','SqsManagedSseEnabled','--output','json') | ConvertFrom-Json
  $queueArn = [string]$queueAttributesReadback.Attributes.QueueArn
  $sseManagedEnabled = [string]$queueAttributesReadback.Attributes.SqsManagedSseEnabled
  if ($sseManagedEnabled -ne 'true') { throw "SQS receiver did not report SqsManagedSseEnabled=true (reported '$sseManagedEnabled')" }
  $policy = [ordered]@{ Version = '2012-10-17'; Statement = @([ordered]@{ Sid = 'AllowExactQualificationTopic'; Effect = 'Allow'; Principal = [ordered]@{ Service = 'sns.amazonaws.com' }; Action = 'sqs:SendMessage'; Resource = $queueArn; Condition = [ordered]@{ ArnEquals = [ordered]@{ 'aws:SourceArn' = $topicArn } } }) } | ConvertTo-Json -Depth 8 -Compress
  $attrs = @{ Policy = $policy } | ConvertTo-Json -Compress
  Invoke-AwsCli @('sqs','set-queue-attributes','--region',$Region,'--queue-url',$queueUrl,'--attributes',$attrs) | Out-Null
  $subscriptionArn = (Invoke-AwsCli @('sns','subscribe','--region',$Region,'--topic-arn',$topicArn,'--protocol','sqs','--notification-endpoint',$queueArn,'--return-subscription-arn','--query','SubscriptionArn','--output','text')).Trim()
  $result.resources = [ordered]@{ topicArn = $topicArn; queueUrl = $queueUrl; queueArn = $queueArn; queueEncryption = 'SSE-SQS'; SqsManagedSseEnabled = $sseManagedEnabled; subscriptionArn = $subscriptionArn }
  Add-Observation 'resource-create' 'PASS' 'Created one ephemeral topic and SSE-SQS receiver with exact-source policy'

  foreach ($entry in $matrix) {
    $name = Get-AlarmName $entry
    $metric = "P9F07_$($entry.id)"
    Invoke-AwsCli @('cloudwatch','put-metric-alarm','--region',$Region,'--alarm-name',$name,'--alarm-description',"Synthetic Package 9 threshold $($entry.id) $runKey",'--namespace',$namespace,'--metric-name',$metric,'--dimensions',"Name=ThresholdId,Value=$($entry.id)",'--statistic','Maximum','--period','60','--evaluation-periods','1','--datapoints-to-alarm','1','--threshold',(Format-Number $entry.limit),'--comparison-operator',$entry.operator,'--treat-missing-data','notBreaching','--alarm-actions',$topicArn,'--ok-actions',$topicArn) | Out-Null
    $createdAlarmNames.Add($name)
  }
  $described = Invoke-AwsCli @('cloudwatch','describe-alarms','--region',$Region,'--alarm-name-prefix',$runKey,'--output','json') | ConvertFrom-Json
  if (@($described.MetricAlarms).Count -ne $matrix.Count) { throw 'Created alarm count differs from declared threshold matrix' }
  foreach ($entry in $matrix) {
    $name = Get-AlarmName $entry
    $found = @($described.MetricAlarms | Where-Object { $_.AlarmName -eq $name })
    if ($found.Count -ne 1) { throw "Expected exactly one alarm named $name" }
    $a = $found[0]
    if ($a.Namespace -ne $namespace -or $a.MetricName -ne "P9F07_$($entry.id)" -or $a.Threshold -ne $entry.limit -or $a.ComparisonOperator -ne $entry.operator -or @($a.Dimensions).Count -ne 1 -or $a.Dimensions[0].Name -ne 'ThresholdId' -or $a.Dimensions[0].Value -ne $entry.id -or @($a.AlarmActions).Count -ne 1 -or $a.AlarmActions[0] -ne $topicArn -or @($a.OKActions).Count -ne 1 -or $a.OKActions[0] -ne $topicArn) { throw "Configured alarm identity or action mismatch: $name" }
    $alarms[$entry.id] = $a
  }
  Add-Observation 'alarm-create' 'PASS' "Created and identity-checked all $($matrix.Count) ephemeral alarms"

  # Exercise every warning and stop threshold independently, including recovery, before proceeding.
  foreach ($entry in $matrix) {
    Invoke-AwsCli @('cloudwatch','put-metric-data','--region',$Region,'--namespace',$namespace,'--metric-name',"P9F07_$($entry.id)",'--dimensions',"Name=ThresholdId,Value=$($entry.id)",'--value',(Format-Number $entry.breachValue),'--unit',$entry.unit) | Out-Null
    $alarmTransitionTime = Wait-AlarmState (Get-AlarmName $entry) 'ALARM'
    Receive-OneState $entry 'ALARM' $alarmTransitionTime

    Invoke-AwsCli @('cloudwatch','put-metric-data','--region',$Region,'--namespace',$namespace,'--metric-name',"P9F07_$($entry.id)",'--dimensions',"Name=ThresholdId,Value=$($entry.id)",'--value','0','--unit',$entry.unit) | Out-Null
    $recoveryTransitionTime = Wait-AlarmState (Get-AlarmName $entry) 'OK'
    Receive-OneState $entry 'OK' $recoveryTransitionTime
  }
  Clear-AndVerifyQueue

  foreach ($entry in $matrix) {
    $history = Invoke-AwsCli @('cloudwatch','describe-alarm-history','--region',$Region,'--alarm-name',(Get-AlarmName $entry),'--history-item-type','StateUpdate','--max-records','10','--output','json') | ConvertFrom-Json
    $states = @($history.AlarmHistoryItems | ForEach-Object { (($_.HistoryData | ConvertFrom-Json).newState.stateValue) })
    if ($states -notcontains 'ALARM' -or $states -notcontains 'OK') { throw "Alarm history lacks both transitions for $($entry.id)" }
  }
  Add-Observation 'sequence-verification' 'PASS' 'All matrix alarms recorded ALARM and recovery OK transitions'
  $result.result = 'PASS_LIMITED_SCOPE'
}
catch {
  $result.result = 'FAIL'
  Add-Observation 'failure' 'FAIL' $_.Exception.Message
}
finally {
      if ($null -ne $identity) {
    if ($createdAlarmNames.Count -gt 0) {
      try { Invoke-AwsCli @('cloudwatch','delete-alarms','--region',$Region,'--alarm-names',@($createdAlarmNames)) | Out-Null; $result.cleanup.alarmsDeleted = $true }
      catch { $cleanupErrors.Add($_.Exception.Message); $result.cleanup.alarmsDeleted = $false }
    } else { $result.cleanup.alarmsDeleted = $true }
    if ($subscriptionArn) { try { Invoke-AwsCli @('sns','unsubscribe','--region',$Region,'--subscription-arn',$subscriptionArn) | Out-Null; $result.cleanup.subscriptionDeleted = $true } catch { $cleanupErrors.Add($_.Exception.Message); $result.cleanup.subscriptionDeleted = $false } }
    if ($topicArn) {
      try { $remainingSubscriptions = (Invoke-AwsCli @('sns','list-subscriptions-by-topic','--region',$Region,'--topic-arn',$topicArn,'--query','length(Subscriptions)','--output','text')).Trim(); $result.cleanup.subscriptionsAbsent = $remainingSubscriptions -eq '0' }
      catch { $cleanupErrors.Add($_.Exception.Message); $result.cleanup.subscriptionsAbsent = $false }
    }
    if ($topicArn) { try { Invoke-AwsCli @('sns','delete-topic','--region',$Region,'--topic-arn',$topicArn) | Out-Null; $result.cleanup.topicDeleted = $true } catch { $cleanupErrors.Add($_.Exception.Message); $result.cleanup.topicDeleted = $false } }
    if ($queueUrl) { try { Invoke-AwsCli @('sqs','delete-queue','--region',$Region,'--queue-url',$queueUrl) | Out-Null; $result.cleanup.queueDeleted = $true } catch { $cleanupErrors.Add($_.Exception.Message); $result.cleanup.queueDeleted = $false } }
    Start-Sleep -Seconds 2
    if ($createdAlarmNames.Count -gt 0) {
      try { $remaining = (Invoke-AwsCli @('cloudwatch','describe-alarms','--region',$Region,'--alarm-names',@($createdAlarmNames),'--query','length(MetricAlarms)','--output','text')).Trim(); $result.cleanup.alarmsAbsent = $remaining -eq '0' }
      catch { $cleanupErrors.Add($_.Exception.Message); $result.cleanup.alarmsAbsent = $false }
    } else { $result.cleanup.alarmsAbsent = $true }
    try { $remaining = (Invoke-AwsCli @('sns','list-topics','--region',$Region,'--query',"length(Topics[?ends_with(TopicArn, ':$topicName')])",'--output','text')).Trim(); $result.cleanup.topicAbsent = $remaining -eq '0' } catch { $cleanupErrors.Add($_.Exception.Message); $result.cleanup.topicAbsent = $false }
    $queueLookup = & aws.exe sqs get-queue-url --region $Region --queue-name $queueName --output json 2>&1
    $queueLookupCode = $LASTEXITCODE
    $queueLookupText = $queueLookup -join "`n"
    $result.cleanup.queueAbsent = $queueLookupCode -ne 0 -and $queueLookupText -match 'NonExistentQueue'
    if ($queueLookupCode -ne 0 -and -not $result.cleanup.queueAbsent) {
      $cleanupErrors.Add("Could not verify queue absence: $queueLookupText")
    }
  }
  $result.cleanup.errors = @($cleanupErrors)
  $result.completedAt = (Get-Date).ToUniversalTime().ToString('o')
  if ($cleanupErrors.Count -gt 0 -or $result.cleanup.alarmsAbsent -ne $true -or $result.cleanup.topicAbsent -ne $true -or $result.cleanup.queueAbsent -ne $true -or $result.cleanup.subscriptionsAbsent -ne $true) {
    if ($result.result -eq 'PASS_LIMITED_SCOPE') { $result.result = 'FAIL_CLEANUP' }
  }
  Write-Output 'P9_F07_MATRIX_FINAL_JSON_BEGIN'
  Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
  Write-Output 'P9_F07_MATRIX_FINAL_JSON_END'
}
if ($result.result -ne 'PASS_LIMITED_SCOPE') { exit 1 }
