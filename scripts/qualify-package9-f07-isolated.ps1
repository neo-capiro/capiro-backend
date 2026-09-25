[CmdletBinding()]
param(
  [string]$Region = 'us-east-1'
)

$ErrorActionPreference = 'Stop'

$runKey = 'p9-f07-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' +
  ([guid]::NewGuid().ToString('N').Substring(0, 6))
$topicName = "$runKey-topic"
$queueName = "$runKey-receiver"
$alarmName = "$runKey-alarm"
$namespace = "Capiro/Package9/F07/$runKey"
$metricName = 'QualificationPulse'

$topicArn = $null
$queueUrl = $null
$queueArn = $null
$subscriptionArn = $null
$observations = [System.Collections.Generic.List[object]]::new()
$result = [ordered]@{
  schemaVersion = 1
  runKey = $runKey
  region = $Region
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  completedAt = $null
  callerArn = $null
  alarmName = $alarmName
  namespace = $namespace
  metricName = $metricName
  resources = [ordered]@{}
  observations = $observations
  alarmHistory = @()
  cleanup = [ordered]@{}
  result = 'RUNNING'
  limitation = 'Synthetic CloudWatch to SNS to SQS alarm delivery, acknowledgement, and recovery only; does not prove product F07 stop-admission, human receipt, or evidence preservation.'
}

function Invoke-AwsCli {
  param([string[]]$Arguments)

  $output = & aws.exe @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "aws $($Arguments -join ' ') failed: $($output -join "`n")"
  }
  return ($output -join "`n")
}

function Add-Observation {
  param(
    [string]$Phase,
    [string]$State,
    [string]$Detail,
    [object]$Extra = $null
  )

  $record = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString('o')
    phase = $Phase
    state = $State
    detail = $Detail
  }
  if ($null -ne $Extra) {
    foreach ($property in $Extra.PSObject.Properties) {
      $record[$property.Name] = $property.Value
    }
  }
  $observations.Add($record)
  Write-Output "[$((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))] $Phase $State $Detail"
}

function Wait-AlarmState {
  param([string]$DesiredState)

  $deadline = (Get-Date).AddSeconds(420)
  do {
    $state = (Invoke-AwsCli @(
      'cloudwatch', 'describe-alarms', '--region', $Region,
      '--alarm-names', $alarmName,
      '--query', 'MetricAlarms[0].StateValue', '--output', 'text'
    )).Trim()
    if ($state -eq $DesiredState) {
      Add-Observation 'alarm-state' $DesiredState 'CloudWatch state reached'
      return
    }
    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for alarm state $DesiredState"
}

function ConvertFrom-SqsBatch {
  param([string]$Raw)

  if ([string]::IsNullOrWhiteSpace($Raw)) {
    return
  }
  $batch = $Raw | ConvertFrom-Json
  if ($null -eq $batch -or $null -eq $batch.Messages) {
    return
  }
  foreach ($message in @($batch.Messages)) {
    $message
  }
}

function Receive-ExpectedState {
  param([string]$DesiredState)

  $deadline = (Get-Date).AddSeconds(420)
  do {
    $messages = @(ConvertFrom-SqsBatch (Invoke-AwsCli @(
      'sqs', 'receive-message', '--region', $Region,
      '--queue-url', $queueUrl,
      '--wait-time-seconds', '20', '--max-number-of-messages', '10',
      '--attribute-names', 'All', '--output', 'json'
    )))
    foreach ($message in $messages) {
      $snsEnvelope = $message.Body | ConvertFrom-Json
      $cloudWatchMessage = $snsEnvelope.Message | ConvertFrom-Json
      Invoke-AwsCli @(
        'sqs', 'delete-message', '--region', $Region,
        '--queue-url', $queueUrl, '--receipt-handle', $message.ReceiptHandle
      ) | Out-Null

      if (
        $cloudWatchMessage.AlarmName -eq $alarmName -and
        $cloudWatchMessage.NewStateValue -eq $DesiredState
      ) {
        Add-Observation 'delivery' $DesiredState `
          'Received and acknowledged expected isolated notification' `
          ([pscustomobject]@{
            snsMessageId = $snsEnvelope.MessageId
            sqsMessageId = $message.MessageId
            oldState = $cloudWatchMessage.OldStateValue
            newState = $cloudWatchMessage.NewStateValue
            stateChangeTime = $cloudWatchMessage.StateChangeTime
            reason = $cloudWatchMessage.NewStateReason
          })
        return
      }
      Add-Observation 'delivery-unexpected' ([string]$cloudWatchMessage.NewStateValue) `
        'Acknowledged non-target message on isolated queue'
    }
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for $DesiredState delivery"
}

function Clear-AtLeastOnceDuplicates {
  $consecutiveEmptyReceives = 0
  $duplicateCount = 0
  while ($consecutiveEmptyReceives -lt 2) {
    $messages = @(ConvertFrom-SqsBatch (Invoke-AwsCli @(
      'sqs', 'receive-message', '--region', $Region,
      '--queue-url', $queueUrl,
      '--wait-time-seconds', '2', '--max-number-of-messages', '10',
      '--output', 'json'
    )))
    if ($messages.Count -eq 0) {
      $consecutiveEmptyReceives += 1
      continue
    }

    $consecutiveEmptyReceives = 0
    foreach ($message in $messages) {
      $snsEnvelope = $message.Body | ConvertFrom-Json
      $cloudWatchMessage = $snsEnvelope.Message | ConvertFrom-Json
      Invoke-AwsCli @(
        'sqs', 'delete-message', '--region', $Region,
        '--queue-url', $queueUrl, '--receipt-handle', $message.ReceiptHandle
      ) | Out-Null
      $duplicateCount += 1
      Add-Observation 'delivery-duplicate' ([string]$cloudWatchMessage.NewStateValue) `
        'Acknowledged additional at-least-once delivery' `
        ([pscustomobject]@{
          snsMessageId = $snsEnvelope.MessageId
          sqsMessageId = $message.MessageId
        })
    }
    if ($duplicateCount -gt 20) {
      throw 'Unexpected duplicate delivery volume'
    }
  }

  Add-Observation 'ack-verification' 'PASS' `
    "Two consecutive empty receives after acknowledging $duplicateCount additional deliveries"
}

try {
  $identity = Invoke-AwsCli @('sts', 'get-caller-identity', '--output', 'json') |
    ConvertFrom-Json
  $result.callerArn = $identity.Arn
  Add-Observation 'preflight' 'PASS' "Caller $($identity.Arn)"

  $existingAlarmCount = (Invoke-AwsCli @(
    'cloudwatch', 'describe-alarms', '--region', $Region,
    '--alarm-names', $alarmName,
    '--query', 'length(MetricAlarms)', '--output', 'text'
  )).Trim()
  if ($existingAlarmCount -ne '0') {
    throw "Alarm already exists: $alarmName"
  }
  $existingTopicCount = (Invoke-AwsCli @(
    'sns', 'list-topics', '--region', $Region,
    '--query', "length(Topics[?ends_with(TopicArn, ':$topicName')])", '--output', 'text'
  )).Trim()
  if ($existingTopicCount -ne '0') {
    throw "Topic already exists: $topicName"
  }
  & aws.exe sqs get-queue-url --region $Region --queue-name $queueName --output json *> $null
  if ($LASTEXITCODE -eq 0) {
    throw "Queue already exists: $queueName"
  }
  Add-Observation 'preflight' 'PASS' 'Exact ephemeral resource names absent'

  $topicArn = (Invoke-AwsCli @(
    'sns', 'create-topic', '--region', $Region,
    '--name', $topicName, '--query', 'TopicArn', '--output', 'text'
  )).Trim()
  $queueUrl = (Invoke-AwsCli @(
    'sqs', 'create-queue', '--region', $Region,
    '--queue-name', $queueName,
    '--attributes', 'SqsManagedSseEnabled=true',
    '--query', 'QueueUrl', '--output', 'text'
  )).Trim()
  $queueArn = (Invoke-AwsCli @(
    'sqs', 'get-queue-attributes', '--region', $Region,
    '--queue-url', $queueUrl, '--attribute-names', 'QueueArn',
    '--query', 'Attributes.QueueArn', '--output', 'text'
  )).Trim()
  $result.resources = [ordered]@{
    topicArn = $topicArn
    queueUrl = $queueUrl
    queueArn = $queueArn
    subscriptionArn = $null
  }
  Add-Observation 'resource-create' 'PASS' 'Created isolated encrypted queue and topic'

  $policy = [ordered]@{
    Version = '2012-10-17'
    Statement = @([ordered]@{
      Sid = 'AllowExactQualificationTopic'
      Effect = 'Allow'
      Principal = [ordered]@{ Service = 'sns.amazonaws.com' }
      Action = 'sqs:SendMessage'
      Resource = $queueArn
      Condition = [ordered]@{
        ArnEquals = [ordered]@{ 'aws:SourceArn' = $topicArn }
      }
    })
  } | ConvertTo-Json -Depth 8 -Compress
  $queueAttributes = @{ Policy = $policy } | ConvertTo-Json -Compress
  Invoke-AwsCli @(
    'sqs', 'set-queue-attributes', '--region', $Region,
    '--queue-url', $queueUrl, '--attributes', $queueAttributes
  ) | Out-Null
  $subscriptionArn = (Invoke-AwsCli @(
    'sns', 'subscribe', '--region', $Region,
    '--topic-arn', $topicArn, '--protocol', 'sqs',
    '--notification-endpoint', $queueArn, '--return-subscription-arn',
    '--query', 'SubscriptionArn', '--output', 'text'
  )).Trim()
  $result.resources.subscriptionArn = $subscriptionArn
  Add-Observation 'resource-bind' 'PASS' 'Bound exact-topic queue policy and subscription'

  Invoke-AwsCli @(
    'cloudwatch', 'put-metric-alarm', '--region', $Region,
    '--alarm-name', $alarmName,
    '--alarm-description', "Package 9 isolated F07 qualification $runKey",
    '--namespace', $namespace, '--metric-name', $metricName,
    '--statistic', 'Average', '--period', '60',
    '--evaluation-periods', '1', '--datapoints-to-alarm', '1',
    '--threshold', '0.5', '--comparison-operator', 'GreaterThanThreshold',
    '--treat-missing-data', 'notBreaching',
    '--alarm-actions', $topicArn, '--ok-actions', $topicArn
  ) | Out-Null
  Add-Observation 'alarm-create' 'PASS' `
    'Created isolated alarm with only ephemeral SNS actions'

  Invoke-AwsCli @(
    'cloudwatch', 'put-metric-data', '--region', $Region,
    '--namespace', $namespace, '--metric-name', $metricName,
    '--value', '1', '--unit', 'Count'
  ) | Out-Null
  Wait-AlarmState 'ALARM'
  Receive-ExpectedState 'ALARM'

  Invoke-AwsCli @(
    'cloudwatch', 'put-metric-data', '--region', $Region,
    '--namespace', $namespace, '--metric-name', $metricName,
    '--value', '0', '--unit', 'Count'
  ) | Out-Null
  Wait-AlarmState 'OK'
  Receive-ExpectedState 'OK'
  Clear-AtLeastOnceDuplicates

  $history = Invoke-AwsCli @(
    'cloudwatch', 'describe-alarm-history', '--region', $Region,
    '--alarm-name', $alarmName, '--history-item-type', 'StateUpdate',
    '--max-records', '20', '--output', 'json'
  ) | ConvertFrom-Json
  $result.alarmHistory = @($history.AlarmHistoryItems | ForEach-Object {
    [ordered]@{
      timestamp = $_.Timestamp
      historySummary = $_.HistorySummary
      historyData = ($_.HistoryData | ConvertFrom-Json)
    }
  })
  $states = @($result.alarmHistory | ForEach-Object {
    $_.historyData.newState.stateValue
  })
  if ($states -notcontains 'ALARM' -or $states -notcontains 'OK') {
    throw "Alarm history missing required states: $($states -join ',')"
  }
  Add-Observation 'sequence-verification' 'PASS' `
    'History contains ALARM and recovery OK'
  $result.result = 'PASS_LIMITED_SCOPE'
}
catch {
  $result.result = 'FAIL'
  Add-Observation 'failure' 'FAIL' $_.Exception.Message
}
finally {
  $cleanupErrors = [System.Collections.Generic.List[string]]::new()
  if ($alarmName) {
    try {
      Invoke-AwsCli @(
        'cloudwatch', 'delete-alarms', '--region', $Region,
        '--alarm-names', $alarmName
      ) | Out-Null
      $result.cleanup.alarmDeleted = $true
    }
    catch {
      $cleanupErrors.Add($_.Exception.Message)
      $result.cleanup.alarmDeleted = $false
    }
  }
  if ($subscriptionArn) {
    try {
      Invoke-AwsCli @(
        'sns', 'unsubscribe', '--region', $Region,
        '--subscription-arn', $subscriptionArn
      ) | Out-Null
      $result.cleanup.subscriptionDeleted = $true
    }
    catch {
      $cleanupErrors.Add($_.Exception.Message)
      $result.cleanup.subscriptionDeleted = $false
    }
  }
  if ($topicArn) {
    try {
      Invoke-AwsCli @(
        'sns', 'delete-topic', '--region', $Region, '--topic-arn', $topicArn
      ) | Out-Null
      $result.cleanup.topicDeleted = $true
    }
    catch {
      $cleanupErrors.Add($_.Exception.Message)
      $result.cleanup.topicDeleted = $false
    }
  }
  if ($queueUrl) {
    try {
      Invoke-AwsCli @(
        'sqs', 'delete-queue', '--region', $Region, '--queue-url', $queueUrl
      ) | Out-Null
      $result.cleanup.queueDeleted = $true
    }
    catch {
      $cleanupErrors.Add($_.Exception.Message)
      $result.cleanup.queueDeleted = $false
    }
  }

  Start-Sleep -Seconds 2
  try {
    $remainingAlarmCount = (Invoke-AwsCli @(
      'cloudwatch', 'describe-alarms', '--region', $Region,
      '--alarm-names', $alarmName,
      '--query', 'length(MetricAlarms)', '--output', 'text'
    )).Trim()
    $result.cleanup.alarmAbsent = $remainingAlarmCount -eq '0'
  }
  catch {
    $cleanupErrors.Add($_.Exception.Message)
    $result.cleanup.alarmAbsent = $false
  }
  try {
    $remainingTopicCount = (Invoke-AwsCli @(
      'sns', 'list-topics', '--region', $Region,
      '--query', "length(Topics[?ends_with(TopicArn, ':$topicName')])",
      '--output', 'text'
    )).Trim()
    $result.cleanup.topicAbsent = $remainingTopicCount -eq '0'
  }
  catch {
    $cleanupErrors.Add($_.Exception.Message)
    $result.cleanup.topicAbsent = $false
  }
  & aws.exe sqs get-queue-url --region $Region --queue-name $queueName --output json *> $null
  $result.cleanup.queueAbsent = $LASTEXITCODE -ne 0
  $result.cleanup.errors = @($cleanupErrors)
  $result.completedAt = (Get-Date).ToUniversalTime().ToString('o')

  if (
    $cleanupErrors.Count -gt 0 -or
    -not $result.cleanup.alarmAbsent -or
    -not $result.cleanup.topicAbsent -or
    -not $result.cleanup.queueAbsent
  ) {
    if ($result.result -eq 'PASS_LIMITED_SCOPE') {
      $result.result = 'FAIL_CLEANUP'
    }
  }

  Write-Output 'P9_F07_FINAL_JSON_BEGIN'
  Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
  Write-Output 'P9_F07_FINAL_JSON_END'
}

if ($result.result -ne 'PASS_LIMITED_SCOPE') {
  exit 1
}
