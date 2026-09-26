# Read-only preflight by default. -Apply grants only this evaluator family on
# the existing cluster; no shared policy, schedule, target, task, or data changes.
[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$region = 'us-east-1'
$accountId = '967807252336'
$ruleName = 'capiro-dev-bizdev-watch-evaluator'
$roleName = 'capiro-dev-eventbridge-sync-invoker'
$roleArn = "arn:aws:iam::${accountId}:role/$roleName"
$clusterArn = "arn:aws:ecs:${region}:${accountId}:cluster/capiro-dev"
$familyArn = "arn:aws:ecs:${region}:${accountId}:task-definition/$ruleName"
$policyName = 'BizDevWatchEvaluatorRunTask'
$policyPath = Join-Path $PSScriptRoot 'bizdev-watch-invoker-policy.json'

function Invoke-WatchAwsJson {
  param([Parameter(Mandatory)][string[]]$Arguments)
  $output = & aws @Arguments --region $region --output json --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI failed: $($Arguments[0]) $($Arguments[1])" }
  if ($output) { return (($output -join "`n") | ConvertFrom-Json) }
}

$identity = Invoke-WatchAwsJson -Arguments @('sts', 'get-caller-identity')
if ($identity.Account -ne $accountId) { throw 'Wrong AWS account; no changes made.' }
$targets = Invoke-WatchAwsJson -Arguments @('events', 'list-targets-by-rule', '--rule', $ruleName)
$target = @($targets.Targets | Where-Object { $_.Id -eq 'BizDevWatchEvaluator' })
if ($target.Count -ne 1 -or $target[0].Arn -ne $clusterArn -or $target[0].RoleArn -ne $roleArn) {
  throw 'Unexpected scheduler target or invoker role; review actual routing before changing permissions.'
}
$taskArn = $target[0].EcsParameters.TaskDefinitionArn
if ($taskArn -notmatch ('^' + [regex]::Escape($familyArn) + ':\d+$')) {
  throw 'Target is not the expected evaluator task-definition family.'
}
$task = (Invoke-WatchAwsJson -Arguments @('ecs', 'describe-task-definition', '--task-definition', $taskArn)).taskDefinition
$taskRoles = @($task.taskRoleArn, $task.executionRoleArn)
if ($taskRoles.Count -ne 2 -or @($taskRoles | Where-Object { -not $_ }).Count -gt 0) {
  throw 'Task roles are incomplete.'
}

$passRole = Invoke-WatchAwsJson -Arguments (@(
  'iam', 'simulate-principal-policy', '--policy-source-arn', $roleArn,
  '--action-names', 'iam:PassRole', '--resource-arns'
) + $taskRoles + @(
  '--context-entries', 'ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks.amazonaws.com,ContextKeyType=string'
))
foreach ($taskRole in $taskRoles) {
  $roleResults = @($passRole.EvaluationResults | ForEach-Object {
    if ($_.ResourceSpecificResults) { $_.ResourceSpecificResults }
    else { [pscustomobject]@{ EvalResourceName = $_.EvalResourceName; EvalResourceDecision = $_.EvalDecision } }
  } | Where-Object { $_.EvalResourceName -eq $taskRole })
  if ($roleResults.Count -ne 1 -or $roleResults[0].EvalResourceDecision -ne 'allowed') {
    throw 'Existing PassRole permissions do not cover both evaluator roles; no changes made.'
  }
}

$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$statement = @($policy.Statement)
if ($policy.Version -ne '2012-10-17' -or $statement.Count -ne 1 -or
    $statement[0].Effect -ne 'Allow' -or $statement[0].Action -ne 'ecs:RunTask' -or
    $statement[0].Resource -ne "${familyArn}:*" -or
    $statement[0].Condition.ArnEquals.'ecs:cluster' -ne $clusterArn) {
  throw 'Unexpected permission scope in policy file; no changes made.'
}

$simulationArgs = @(
  'iam', 'simulate-principal-policy', '--policy-source-arn', $roleArn,
  '--action-names', 'ecs:RunTask', '--resource-arns', $taskArn,
  '--context-entries', "ContextKeyName=ecs:cluster,ContextKeyValues=$clusterArn,ContextKeyType=string"
)
$before = Invoke-WatchAwsJson -Arguments $simulationArgs
$policyInputList = ConvertTo-Json -InputObject @($policy | ConvertTo-Json -Depth 15 -Compress) -Compress
$proposed = Invoke-WatchAwsJson -Arguments ($simulationArgs + @('--policy-input-list', $policyInputList))
if (@($proposed.EvaluationResults).Count -ne 1 -or $proposed.EvaluationResults[0].EvalDecision -ne 'allowed') {
  throw 'Proposed narrow policy does not resolve RunTask authorization; no changes made.'
}

# The dedicated policy is owned by this repair. Never overwrite drift silently
# and never rewrite the shared RunTaskAndPassRole policy used by other jobs.
$policies = Invoke-WatchAwsJson -Arguments @('iam', 'list-role-policies', '--role-name', $roleName)
$alreadyPresent = @($policies.PolicyNames) -contains $policyName
if ($alreadyPresent) {
  $existing = (Invoke-WatchAwsJson -Arguments @('iam', 'get-role-policy', '--role-name', $roleName, '--policy-name', $policyName)).PolicyDocument
  if (($existing | ConvertTo-Json -Depth 15 -Compress) -ne ($policy | ConvertTo-Json -Depth 15 -Compress)) {
    throw 'The dedicated policy differs from the reviewed file; review drift before applying.'
  }
}
if ($Apply -and -not $alreadyPresent) {
  Invoke-WatchAwsJson -Arguments @(
    'iam', 'put-role-policy', '--role-name', $roleName,
    '--policy-name', $policyName, '--policy-document', "file://$policyPath"
  ) | Out-Null
}
$after = if ($Apply) { Invoke-WatchAwsJson -Arguments $simulationArgs } else { $before }
[ordered]@{
  account = $accountId
  rule = $ruleName
  taskDefinition = $taskArn
  role = $roleName
  policy = $policyName
  applied = [bool]$Apply
  alreadyPresent = $alreadyPresent
  beforeDecision = $before.EvaluationResults[0].EvalDecision
  proposedDecision = $proposed.EvaluationResults[0].EvalDecision
  afterDecision = $after.EvaluationResults[0].EvalDecision
  note = 'Policy simulation is not delivery proof. Verify the next scheduled launch, exit code and summary; preserve the hourly cadence.'
} | ConvertTo-Json
