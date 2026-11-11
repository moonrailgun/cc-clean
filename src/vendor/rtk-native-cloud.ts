// Copyright 2026 RTK AI Labs. Licensed under Apache-2.0.
// Modified by cc-clean: pure historical-output TypeScript port, strict schemas,
// exact JSON numbers, failure retention, and no execution/telemetry/tee effects.
// Source: RTK 0.49.0, 653efb6ed02bd287d686c50e830dd1009356904f.
// Mapping and deliberate safety differences: third_party/rtk/NATIVE-CLOUD.md.
import { clean, json, lines, object, string, truncate, uint, type Filter, type Obj } from './rtk-native-common.ts';

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;
const anything: Check = () => true;
const boolean: Check = value => typeof value === 'boolean';
const integer: Check = value => Number.isSafeInteger(value);
const number: Check = value => typeof value === 'number' && Number.isFinite(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const strings = array(string);
const ignored = (names: string): Fields => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, anything]));
function shape(required: Fields, optional: Fields = {}): (value: unknown) => value is Obj {
  return (value): value is Obj => object(value)
    && Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
    && Object.entries(value).every(([key, val]) => Object.hasOwn(required, key) ? required[key](val) : Object.hasOwn(optional, key) && optional[key](val));
}
const s = (value: Obj, key: string, fallback = ''): string => value[key] as string ?? fallback;
const n = (value: Obj, key: string, fallback = 0): number => value[key] as number ?? fallback;
const o = (value: Obj, key: string): Obj => value[key] as Obj;
const a = (value: Obj, key: string): Obj[] => value[key] as Obj[] ?? [];
const date = (value: string): string => Array.from(value).slice(0, 10).join('');
const arn = (value: string): string => value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value.slice(value.lastIndexOf(':') + 1);
const cap = (values: string[], label: string, limit = 20): string => [...values.slice(0, limit), ...(values.length > limit ? [`… +${values.length - limit} more ${label}`] : [])].join('\n');
const failure = (value: string): boolean => /(?:^|[^A-Za-z])(?:error|failed|failure|fatal|warning|denied|conflict|stopped)(?:$|[^A-Za-z])|exit:-?[1-9]/i.test(value);

// Removing only JSON whitespace preserves number lexemes, duplicate keys, and
// string escapes. Parsing is validation only; it never supplies rewritten values.
function minify(input: string): string {
  if (json(input) === undefined) return input;
  let quoted = false, escaped = false, out = '';
  for (const char of input) {
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; out += char; }
    else if (!' \t\r\n'.includes(char)) out += char;
  }
  return out;
}

function safeNumbers(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(safeNumbers);
  return !object(value) || Object.values(value).every(safeNumbers);
}
function structured(check: Check, render: (value: Obj) => string): Filter {
  return input => {
    const value = json(input);
    if (!check(value) || !safeNumbers(value)) return input;
    try { return render(value as Obj) || input; } catch { return input; }
  };
}
const pagination: Fields = { NextToken: string, nextToken: string, NextMarker: string, Marker: string, IsTruncated: boolean };
const emptyFailures: Check = value => Array.isArray(value) && value.length === 0;
function paginated(value: Obj): boolean {
  return ['NextToken','nextToken','NextMarker'].some(key => typeof value[key] === 'string' && value[key] !== '') || value.IsTruncated === true;
}
function listFilter(key: string, check: Check, render: (value: Obj) => string, label: string, extra: Fields = {}, limit = 20): Filter {
  return structured(shape({ [key]: array(check) }, { ...pagination, ...extra }), value => {
    const rows = a(value, key).map(render);
    if (rows.slice(limit).some(failure)) return '';
    const result = cap(rows, label, limit);
    return result + (paginated(value) ? '\n(paginated — more results available)' : '');
  });
}

const tag = shape({ Key: string, Value: string });
const securityGroupRef = shape({ GroupId: string }, { GroupName: string });
const instance = shape({ InstanceId: string, InstanceType: string, State: shape({ Name: string }, { Code: uint }) }, {
  PrivateIpAddress: string, PublicIpAddress: string, SubnetId: string, VpcId: string, Tags: array(tag), SecurityGroups: array(securityGroupRef),
  ...ignored('AmiLaunchIndex ImageId KeyName LaunchTime Monitoring Placement Architecture BlockDeviceMappings ClientToken EbsOptimized EnaSupport Hypervisor IamInstanceProfile NetworkInterfaces RootDeviceName RootDeviceType SourceDestCheck StateReason StateTransitionReason VirtualizationType CpuOptions CapacityReservationSpecification HibernationOptions MetadataOptions EnclaveOptions Platform PlatformDetails UsageOperation UsageOperationUpdateTime PrivateDnsName PublicDnsName ProductCodes BootMode CurrentInstanceBootMode MaintenanceOptions NetworkPerformanceOptions Operator TpmSupport InstanceLifecycle SpotInstanceRequestId ElasticGpuAssociations ElasticInferenceAcceleratorAssociations'),
});
const stackShape = shape({ StackName: string, StackStatus: string }, {
  CreationTime: string, LastUpdatedTime: string, Outputs: array(shape({ OutputKey: string, OutputValue: string }, ignored('Description ExportName'))),
  StackStatusReason: string,
  ...ignored('StackId Description TemplateDescription DeletionTime ParentId RootId DriftInformation RetainExceptOnCreate EnableTerminationProtection RoleARN Parameters Capabilities NotificationARNs Tags TimeoutInMinutes DisableRollback RollbackConfiguration DetailedStatus LastOperations DeletionMode'),
});
const stack: Check = value => stackShape(value) && (string(value.CreationTime) || string(value.LastUpdatedTime));
const stackSummary = (value: Obj): string => `${s(value,'StackName')} ${s(value,'StackStatus')} ${date(s(value,'LastUpdatedTime',s(value,'CreationTime')))}${value.StackStatusReason ? ` reason:${s(value,'StackStatusReason')}` : ''}`;
const lambda = shape({ FunctionName: string, Runtime: string, MemorySize: uint, Timeout: uint }, {
  State: string, Handler: string, LastModified: string, Layers: array(shape({ Arn: string }, ignored('CodeSize SigningProfileVersionArn SigningJobArn'))),
  ...ignored('FunctionArn Role CodeSize Description CodeSha256 Version VpcConfig DeadLetterConfig Environment KMSKeyArn TracingConfig MasterArn RevisionId FileSystemConfigs PackageType ImageConfigResponse SigningProfileVersionArn SigningJobArn Architectures EphemeralStorage SnapStart RuntimeVersionConfig LoggingConfig Code StateReason StateReasonCode LastUpdateStatus LastUpdateStatusReason LastUpdateStatusReasonCode'),
});
const lambdaSummary = (value: Obj): string => `${s(value,'FunctionName')} ${s(value,'Runtime')} ${n(value,'MemorySize')}MB ${n(value,'Timeout')}s ${s(value,'State','active')}`;
const capacity = shape({ CapacityUnits: number }, ignored('TableName Table LocalSecondaryIndexes GlobalSecondaryIndexes ReadCapacityUnits WriteCapacityUnits'));
const capacityLine = (value: Obj): string[] => object(value.ConsumedCapacity) ? [`Capacity: ${n(value.ConsumedCapacity,'CapacityUnits')} RCU`] : [];

// Typed DynamoDB maps need a separate root path: an attribute named N or S is
// ordinary user data. Serializing numeric strings directly retains all digits.
function dynamoMap(value: unknown, depth = 0): string | undefined {
  if (!object(value) || depth > 10) return undefined;
  const pairs: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const val = dynamoValue(value[key], depth + 1);
    if (val === undefined) return undefined;
    pairs.push(`${JSON.stringify(key)}:${val}`);
  }
  return `{${pairs.join(',')}}`;
}
const numericText = (value: unknown): value is string => string(value) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
function dynamoValue(value: unknown, depth: number): string | undefined {
  if (!object(value) || depth > 10 || Object.keys(value).length !== 1) return undefined;
  const [key, val] = Object.entries(value)[0];
  if (['S','B'].includes(key) && string(val)) return JSON.stringify(val);
  if (key === 'N' && numericText(val)) return val;
  if (key === 'BOOL' && typeof val === 'boolean') return String(val);
  if (key === 'NULL' && val === true) return 'null';
  if (key === 'M') return dynamoMap(val, depth);
  if (key === 'L' && Array.isArray(val)) {
    const values = val.map(entry => dynamoValue(entry, depth + 1));
    return values.some(entry => entry === undefined) ? undefined : `[${values.join(',')}]`;
  }
  if (['SS','BS'].includes(key) && Array.isArray(val) && val.every(string)) return JSON.stringify(val);
  if (key === 'NS' && Array.isArray(val) && val.every(numericText)) return `[${val.join(',')}]`;
  return undefined;
}

const permission = shape({ IpProtocol: string }, {
  FromPort: integer, ToPort: integer,
  IpRanges: array(shape({ CidrIp: string }, { Description: string })),
  Ipv6Ranges: array(shape({ CidrIpv6: string }, { Description: string })),
  UserIdGroupPairs: array(shape({ GroupId: string }, ignored('Description UserId GroupName VpcId VpcPeeringConnectionId PeeringStatus'))),
  PrefixListIds: value => Array.isArray(value) && value.length === 0,
});
function sgRule(value: Obj): string {
  const proto = s(value,'IpProtocol');
  const port = value.FromPort === undefined || value.ToPort === undefined ? '*' : value.FromPort === value.ToPort ? `${value.FromPort}` : `${value.FromPort}-${value.ToPort}`;
  const source = [...a(value,'IpRanges').map(v => s(v,'CidrIp')), ...a(value,'Ipv6Ranges').map(v => s(v,'CidrIpv6')), ...a(value,'UserIdGroupPairs').map(v => s(v,'GroupId'))].join(',') || '?';
  return `${proto === '-1' ? 'all' : `${proto}/${port}`}<-${source}`;
}
function bytes(value: number): string {
  for (const [power, unit] of [[4,'TB'],[3,'GB'],[2,'MB'],[1,'KB']] as const) if (value >= 1024 ** power) return `${(value / 1024 ** power).toFixed(1)} ${unit}`;
  return `${value} B`;
}

const awsFilters: Record<string, Filter> = {
  'aws-sts-identity': structured(shape({ Account: string, Arn: string }, { UserId: string }), value => `AWS: ${s(value,'Account')} ${s(value,'Arn')}`),
  'aws-s3-ls': input => {
    const rows = lines(input);
    if (!rows.every(row => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} +(?:\d+ +)?\S.*$/.test(row) || /^\s*PRE \S.*$/.test(row))) return input;
    return rows.length > 30 ? cap(rows,'items',30) : input;
  },
  'aws-ec2-instances': structured(shape({ Reservations: array(shape({ Instances: array(instance) }, ignored('ReservationId OwnerId RequesterId Groups'))) }, pagination), value => {
    const values = a(value,'Reservations').flatMap(v => a(v,'Instances')).map(v => `${s(v,'InstanceId')} ${s(o(v,'State'),'Name')} ${s(v,'InstanceType')} ${s(v,'PrivateIpAddress','-')} pub:${s(v,'PublicIpAddress','-')} vpc:${s(v,'VpcId','-')} subnet:${s(v,'SubnetId','-')} sg:[${a(v,'SecurityGroups').map(g => s(g,'GroupId')).join(',') || '-'}] (${s(a(v,'Tags').find(t => t.Key === 'Name') ?? {},'Value','-')})`);
    return [`EC2: ${values.length} instances`, ...values.slice(0,20).map(v => `  ${v}`), ...(values.length > 20 ? [`  … +${values.length - 20} more`] : []), ...(paginated(value) ? ['(paginated — more results available)'] : [])].join('\n');
  }),
  'aws-ecs-list-services': structured(shape({ serviceArns: strings }, pagination), v => cap((v.serviceArns as string[]).map(arn),'services') + (paginated(v) ? '\n(paginated — more results available)' : '')),
  'aws-ecs-describe-services': listFilter('services', shape({ serviceName: string, status: string, runningCount: uint, desiredCount: uint, launchType: string }, ignored('serviceArn clusterArn taskDefinition pendingCount loadBalancers serviceRegistries capacityProviderStrategy platformVersion platformFamily deploymentConfiguration deployments roleArn events createdAt placementConstraints placementStrategy networkConfiguration healthCheckGracePeriodSeconds schedulingStrategy deploymentController tags createdBy enableECSManagedTags propagateTags enableExecuteCommand availabilityZoneRebalancing volumeConfigurations vpcLatticeConfigurations')), v => `${s(v,'serviceName')} ${s(v,'status')} ${n(v,'runningCount')}/${n(v,'desiredCount')} (${s(v,'launchType')})`, 'services', { failures: emptyFailures }),
  'aws-rds-instances': listFilter('DBInstances', shape({ DBInstanceIdentifier: string, Engine: string, EngineVersion: string, DBInstanceClass: string, DBInstanceStatus: string, Endpoint: shape({ Address: string, Port: uint }, { HostedZoneId: string }) }, ignored('DBInstanceArn DbiResourceId MasterUsername DBName AllocatedStorage InstanceCreateTime PreferredBackupWindow BackupRetentionPeriod DBSecurityGroups VpcSecurityGroups DBParameterGroups AvailabilityZone DBSubnetGroup PreferredMaintenanceWindow PendingModifiedValues LatestRestorableTime MultiAZ AutoMinorVersionUpgrade ReadReplicaDBInstanceIdentifiers LicenseModel OptionGroupMemberships PubliclyAccessible StorageType StorageEncrypted KmsKeyId DbInstancePort CACertificateIdentifier CopyTagsToSnapshot MonitoringInterval EnhancedMonitoringResourceArn MonitoringRoleArn PromotionTier PerformanceInsightsEnabled PerformanceInsightsKMSKeyId PerformanceInsightsRetentionPeriod DeletionProtection AssociatedRoles IAMDatabaseAuthenticationEnabled TagList CustomerOwnedIpEnabled BackupTarget NetworkType StorageThroughput CertificateDetails DedicatedLogVolume EngineLifecycleSupport')), v => `${s(v,'DBInstanceIdentifier')} ${s(v,'Engine')} ${s(v,'EngineVersion')} ${s(v,'DBInstanceClass')} ${s(v,'DBInstanceStatus')} ${s(o(v,'Endpoint'),'Address')}:${n(o(v,'Endpoint'),'Port')}`, 'instances'),
  'aws-cfn-list-stacks': listFilter('StackSummaries', stack, stackSummary, 'stacks'),
  'aws-cfn-describe-stacks': listFilter('Stacks', stack, v => [stackSummary(v), ...a(v,'Outputs').map(out => `  ${s(out,'OutputKey')}=${s(out,'OutputValue')}`)].join('\n'), 'stacks'),
  'aws-logs-events': listFilter('events', shape({ timestamp: integer, message: string }, ignored('ingestionTime eventId logStreamName')), v => `${n(v,'timestamp') > 0 ? new Date(n(v,'timestamp')).toISOString().slice(0,19).replace('T',' ') : '??:??:??'} ${s(v,'message').startsWith('{') ? minify(s(v,'message').trimEnd()) : s(v,'message').trimEnd()}`, 'events', { nextForwardToken: string, nextBackwardToken: string, searchedLogStreams: anything }, 50),
  'aws-cfn-events': structured(shape({ StackEvents: array(shape({ ResourceStatus: string, LogicalResourceId: string, ResourceType: string, Timestamp: string }, { ResourceStatusReason: string, ...ignored('StackId StackName EventId PhysicalResourceId ResourceProperties ClientRequestToken HookType HookStatus HookStatusReason HookInvocationPoint HookFailureMode DetailedStatus') })) }, pagination), value => {
    const events = a(value,'StackEvents');
    if (events.some(v => !s(v,'ResourceStatus').includes('FAILED') && !s(v,'ResourceStatus').includes('ROLLBACK') && !s(v,'ResourceStatus').endsWith('_COMPLETE'))) return '';
    const failed = events.filter(v => s(v,'ResourceStatus').includes('FAILED') || s(v,'ResourceStatus').includes('ROLLBACK'));
    const successful = events.length - failed.length;
    return [`CloudFormation: ${events.length} events (${failed.length} failed, ${successful} successful)`, ...(failed.length ? ['--- FAILURES ---', ...failed.map(v => `  ${date(s(v,'Timestamp'))} ${s(v,'LogicalResourceId')} ${s(v,'ResourceType').replace(/^AWS::/,'')} ${s(v,'ResourceStatus')}${v.ResourceStatusReason ? ` REASON: ${s(v,'ResourceStatusReason')}` : ''}`)] : []), ...(successful ? [`+ ${successful} successful resources`] : []), ...(paginated(value) ? ['(paginated — more results available)'] : [])].join('\n');
  }),
  'aws-lambda-list': listFilter('Functions', lambda, lambdaSummary, 'functions'),
  'aws-lambda-get': structured(shape({ Configuration: v => lambda(v) && string(v.Handler) && string(v.LastModified) }, ignored('Code Tags Concurrency')), v => {
    const config = o(v,'Configuration');
    const layers = a(config,'Layers').map(l => s(l,'Arn').split(':').slice(-2).join(':'));
    return `${s(config,'FunctionName')} ${s(config,'Runtime')} ${s(config,'Handler')} ${n(config,'MemorySize')}MB ${n(config,'Timeout')}s ${s(config,'State','active')} ${date(s(config,'LastModified'))}${layers.length ? `\n  layers: ${layers.join(', ')}` : ''}`;
  }),
  'aws-iam-roles': listFilter('Roles', shape({ RoleName: string, CreateDate: string }, { Description: string, AssumeRolePolicyDocument: value => object(value) || (string(value) && object(json(value))), ...ignored('Path RoleId Arn MaxSessionDuration PermissionsBoundary Tags RoleLastUsed') }), v => {
    const policy = string(v.AssumeRolePolicyDocument) ? json(v.AssumeRolePolicyDocument) : v.AssumeRolePolicyDocument;
    const principals: string[] = [];
    if (object(policy)) {
      if (!Array.isArray(policy.Statement)) throw new Error('Unrecognized policy');
      for (const statement of policy.Statement) {
        if (!object(statement)) throw new Error('Unrecognized statement');
        const principal = statement.Principal;
        if (string(principal)) principals.push(principal);
        else if (object(principal)) {
          if (Object.keys(principal).some(key => !['Service','AWS'].includes(key))) throw new Error('Unrecognized principal');
          for (const [key, val] of Object.entries(principal)) {
            const values = string(val) ? [val] : Array.isArray(val) && val.every(string) ? val : undefined;
            if (!values) throw new Error('Unrecognized principal');
            principals.push(...values.map(p => key === 'AWS' ? arn(p) : p));
          }
        } else throw new Error('Unrecognized principal');
      }
    }
    const unique = principals.filter((p,i) => i === 0 || p !== principals[i - 1]);
    return `${s(v,'RoleName')} ${date(s(v,'CreateDate'))}${v.Description ? ` [${s(v,'Description')}]` : ''}${unique.length ? ` assume:[${unique.join(',')}]` : ''}`;
  }, 'roles'),
  'aws-iam-users': listFilter('Users', shape({ UserName: string, CreateDate: string }, ignored('Path UserId Arn PasswordLastUsed PermissionsBoundary Tags')), v => `${s(v,'UserName')} created:${date(s(v,'CreateDate'))}`, 'users'),
  'aws-dynamodb-items': structured(shape({ Items: array(v => dynamoMap(v) !== undefined) }, { Count: uint, ScannedCount: uint, ConsumedCapacity: capacity, LastEvaluatedKey: v => dynamoMap(v) !== undefined }), v => [`Count: ${n(v,'Count',a(v,'Items').length)}/${n(v,'ScannedCount',n(v,'Count',a(v,'Items').length))}`, ...capacityLine(v), ...(v.LastEvaluatedKey ? ['(paginated — more results available)'] : []), cap(a(v,'Items').map(item => dynamoMap(item)!), 'items')].filter(Boolean).join('\n')),
  'aws-ecs-tasks': listFilter('tasks', shape({ taskArn: string, lastStatus: string, containers: array(shape({ name: string, lastStatus: string }, { exitCode: integer, ...ignored('containerArn taskArn image imageDigest runtimeId networkBindings networkInterfaces healthStatus cpu memory memoryReservation gpuIds managedAgents') })) }, { stoppedReason: string, ...ignored('attachments attributes availabilityZone clusterArn connectivity connectivityAt cpu createdAt desiredStatus enableExecuteCommand executionStoppedAt group healthStatus inferenceAccelerators launchType memory overrides platformVersion platformFamily pullStartedAt pullStoppedAt startedAt startedBy stopCode stoppedAt stoppingAt tags taskDefinitionArn version ephemeralStorage fargateEphemeralStorage') }), v => `${arn(s(v,'taskArn'))} ${s(v,'lastStatus')} containers:[${a(v,'containers').map(c => `${s(c,'name')}:${s(c,'lastStatus')}${c.exitCode === undefined ? '' : `(exit:${n(c,'exitCode')})`}`).join(', ')}]${v.stoppedReason ? ` reason:${s(v,'stoppedReason')}` : ''}`, 'tasks', { failures: emptyFailures }),
  'aws-security-groups': listFilter('SecurityGroups', shape({ GroupName: string, GroupId: string, IpPermissions: array(permission), IpPermissionsEgress: array(permission) }, ignored('Description OwnerId VpcId Tags SecurityGroupArn')), v => `${s(v,'GroupName')} (${s(v,'GroupId')}) ingress: ${a(v,'IpPermissions').map(sgRule).join('; ') || 'none'} | egress: ${a(v,'IpPermissionsEgress').map(sgRule).join('; ') || 'none'}`, 'groups'),
  'aws-s3-objects': listFilter('Contents', shape({ Key: string, Size: uint, LastModified: string }, ignored('ETag ChecksumAlgorithm ChecksumType StorageClass Owner RestoreStatus')), v => `${s(v,'Key')} ${bytes(n(v,'Size'))} ${date(s(v,'LastModified'))}`, 'objects', { ...ignored('Name Prefix MaxKeys EncodingType KeyCount ContinuationToken StartAfter RequestCharged'), NextContinuationToken: value => value === '', CommonPrefixes: value => Array.isArray(value) && value.length === 0 }),
  'aws-eks-cluster': structured(shape({ cluster: shape({ name: string, status: string, version: string, endpoint: string }, ignored('arn createdAt roleArn resourcesVpcConfig kubernetesNetworkConfig logging identity certificateAuthority clientRequestToken platformVersion tags encryptionConfig connectorConfig id health outpostConfig accessConfig upgradePolicy zonalShiftConfig remoteNetworkConfig computeConfig storageConfig')) }), v => { const c = o(v,'cluster'); return `${s(c,'name')} ${s(c,'status')} k8s/${s(c,'version')} ${s(c,'endpoint')}`; }),
  'aws-sqs-messages': listFilter('Messages', shape({ MessageId: string, Body: string }, ignored('ReceiptHandle MD5OfBody MD5OfMessageAttributes Attributes MessageAttributes')), v => `${Array.from(s(v,'MessageId')).slice(0,8).join('')} ${truncate(s(v,'Body'),200)}`, 'messages'),
  'aws-dynamodb-get-item': structured(shape({ Item: v => dynamoMap(v) !== undefined }, { ConsumedCapacity: capacity }), v => [dynamoMap(v.Item), ...capacityLine(v)].join('\n')),
  'aws-logs-query-results': structured(shape({ status: string, results: array(array(shape({ field: string, value: value => value === null || ['string','number','boolean'].includes(typeof value) }))) }, ignored('statistics encryptionKey queryLanguage')), v => [`Status: ${s(v,'status')}`, cap((v.results as Obj[][]).map(row => row.filter(f => f.field !== '@ptr').map(f => `${s(f,'field')}=${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}`).join(' ')), 'rows')].filter(Boolean).join('\n')),
  'aws-s3-transfer': input => {
    const rows = lines(input); if (rows.length < 10) return input;
    const totals = new Map<string,number>(), errors: string[] = [];
    for (const row of rows) {
      if (failure(row)) { errors.push(row); continue; }
      const match = /^(upload|download|delete|copy|move):\s+\S/.exec(row);
      if (match) totals.set(match[1], (totals.get(match[1]) ?? 0) + 1);
      else if (row.trim() && !/^Completed \d+(?:\.\d+)? \S+\//.test(row)) return input;
    }
    const parts = [['upload','uploaded'],['download','downloaded'],['delete','deleted'],['copy','copied'],['move','moved']].filter(([key]) => totals.has(key)).map(([key,label]) => `${totals.get(key)} ${label}`);
    return parts.length ? [`S3 transfer: ${parts.join(', ')}, ${errors.length} errors`, ...errors].join('\n') : input;
  },
  'aws-secrets-get': structured(shape({ Name: string, SecretString: string }, ignored('ARN VersionId VersionStages CreatedDate')), v => `Name: ${s(v,'Name')}\nSecret: ${minify(s(v,'SecretString'))}`),
  'aws-json': input => { const value = json(input); return object(value) || Array.isArray(value) ? minify(input) : input; },
};

const oneOf = (...values: string[]): Check => value => string(value) && values.includes(value);
const ghState = oneOf('OPEN','CLOSED','MERGED');
const glabState = oneOf('opened','closed','merged','locked');
const ghActor = shape({ login: string }, { id: string, name: nullable(string), is_bot: boolean });
const glabActor = shape({ username: string }, ignored('id name state locked avatar_url web_url'));
const ghCheck = shape({}, {
  conclusion: nullable(oneOf('SUCCESS','FAILURE','NEUTRAL','CANCELLED','TIMED_OUT','ACTION_REQUIRED','STALE','SKIPPED','STARTUP_FAILURE','')),
  state: oneOf('SUCCESS','FAILURE','ERROR','PENDING','EXPECTED'), status: oneOf('QUEUED','IN_PROGRESS','COMPLETED','WAITING','PENDING','REQUESTED'),
  ...ignored('__typename name context detailsUrl targetUrl workflowName startedAt completedAt description isRequired'),
});
const checkRow: Check = value => ghCheck(value) && ['conclusion','state','status'].some(key => Object.hasOwn(value,key));
const checkFailed = (value: Obj): boolean => ['FAILURE','ERROR','TIMED_OUT','ACTION_REQUIRED','STARTUP_FAILURE'].includes(s(value,'conclusion')) || ['FAILURE','ERROR'].includes(s(value,'state'));
const checkPassed = (value: Obj): boolean => value.conclusion === 'SUCCESS' || value.state === 'SUCCESS';
const review = shape({ state: oneOf('APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING') }, { author: nullable(ghActor), ...ignored('id body submittedAt includesCreatedEdit commit') });
const reviews: Check = value => array(review)(value) || shape({ nodes: array(review) })(value);
const ghPr = shape({ number: uint, title: string, state: ghState, author: ghActor }, { updatedAt: string });
const glabMetadata = ignored('id project_id created_at updated_at closed_at closed_by merged_at merged_by merge_user draft work_in_progress milestone assignees assignee user_notes_count upvotes downvotes references discussion_locked time_stats task_completion_status subscribed participants web_url');
const glabMr = shape({ iid: uint, title: string, state: glabState, author: glabActor }, {
  ...glabMetadata, description: nullable(string), source_branch: string, target_branch: string, labels: strings,
  ...ignored('source_project_id target_project_id merge_status detailed_merge_status sha merge_commit_sha squash_commit_sha merge_error merge_when_pipeline_succeeds merge_after squash squash_on_merge should_remove_source_branch force_remove_source_branch allow_collaboration allow_maintainer_to_push blocking_discussions_resolved approvals_before_merge has_conflicts reviewers changes_count diff_refs first_contribution pipeline head_pipeline imported imported_from prepared_at'),
});
const glabIssueMetadata = { ...ignored('id project_id created_at updated_at closed_at closed_by labels milestone assignees assignee type issue_type severity confidential discussion_locked user_notes_count upvotes downvotes due_date weight references web_url time_stats task_completion_status has_tasks task_status _links moved_to_id service_desk_reply_to merge_requests_count health_status blocking_issues_count epic epic_iid iteration imported imported_from'), author: glabActor, description: nullable(string) };
const stateIcons: Record<string,string> = {OPEN:'[open]',CLOSED:'[closed]',MERGED:'[merged]',opened:'[open]',closed:'[closed]',merged:'[merged]',locked:'[locked]'};
const pipelineIcons: Record<string,string> = {success:'[ok]',failed:'[fail]',canceled:'[cancel]',cancelled:'[cancel]',running:'[run]',pending:'[pend]',skipped:'[skip]'};
const icon = (state: string): string => stateIcons[state] ?? '[unknown]';
const pipelineIcon = (state: string): string => pipelineIcons[state] ?? '[?]';
const pipelineState = oneOf('created','waiting_for_resource','preparing','pending','running','success','failed','canceled','cancelled','skipped','manual','scheduled');

function arrayFormat(check: Check, render: (values: Obj[]) => string): Filter {
  return input => {
    const value = json(input);
    if (!Array.isArray(value) || !value.every(check) || !safeNumbers(value)) return input;
    return render(value as Obj[]) || input;
  };
}
function forgeList(title: string, values: Obj[], render: (value: Obj) => string, limit = 20): string {
  if (!values.length) return `No ${title}\n`;
  const rows = values.map(render);
  // Historical snapshots have no tee file: retain a failure beyond the cap by
  // leaving the complete input intact rather than pointing to absent details.
  if (rows.slice(limit).some(failure)) return '';
  return `${title}\n${rows.slice(0,limit).join('\n')}\n${rows.length > limit ? `  … +${rows.length - limit} more\n` : ''}`;
}
function markdownSegment(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g,'').split('\n').map(line =>
    /^\s*(?:\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)|---+|\*\*\*+|___+)\s*$/.test(line) ? '' : line,
  ).join('\n').replace(/\n{3,}/g,'\n\n');
}
function markdown(body: string): string {
  let out = '', rest = body;
  while (rest) {
    const backtick = rest.indexOf('```'), tilde = rest.indexOf('~~~');
    const start = backtick < 0 ? tilde : tilde < 0 ? backtick : Math.min(backtick,tilde);
    if (start < 0) { out += markdownSegment(rest); break; }
    out += markdownSegment(rest.slice(0,start));
    const fence = rest.slice(start,start + 3), openEnd = rest.indexOf('\n',start + 3);
    const close = openEnd < 0 ? -1 : rest.indexOf(fence,openEnd + 1);
    if (close < 0) { out += rest.slice(start); break; }
    const closeEnd = rest.indexOf('\n',close + 3), end = closeEnd < 0 ? rest.length : closeEnd + 1;
    out += rest.slice(start,end); rest = rest.slice(end);
  }
  return out.trim();
}
const indented = (body: string, indent: string): string => lines(body).map(line => `${indent}${line}\n`).join('');
function issueView(value: Obj, gitlab: boolean): string {
  const id = gitlab ? 'iid' : 'number', author = gitlab ? 'username' : 'login', url = gitlab ? 'web_url' : 'url', body = gitlab ? 'description' : 'body';
  let out = `${icon(s(value,'state'))} Issue #${n(value,id)}: ${s(value,'title')}\n  Author: @${s(o(value,'author'),author)}\n  Status: ${s(value,'state')}\n  URL: ${s(value,url)}\n`;
  if (value[body]) {
    const filtered = markdown(s(value,body));
    if (filtered) out += `\n  Description:\n${indented(filtered,'    ')}`;
    else if (!gitlab) out += '\n  Description: (body contained only badges/images/comments)\n';
  }
  return out;
}
const prStatus = shape({ number: uint, title: string }, { reviewDecision: nullable(oneOf('APPROVED','CHANGES_REQUESTED','REVIEW_REQUIRED','PENDING','')), statusCheckRollup: nullable(array(checkRow)) });
function statusEntry(value: Obj): string {
  const checks = a(value,'statusCheckRollup'), failed = checks.filter(checkFailed).length;
  return `  #${n(value,'number')} ${truncate(s(value,'title'),50)} [${s(value,'reviewDecision','PENDING')}]${checks.length ? ` checks ${checks.filter(checkPassed).length}/${checks.length}${failed ? ` fail ${failed}` : ''}` : ''}\n`;
}

const ghFilters: Record<string, Filter> = {
  'gh-pr-list': arrayFormat(ghPr, values => forgeList('Pull Requests',values,v => `  ${icon(s(v,'state'))} #${n(v,'number')} ${truncate(s(v,'title'),60)} (${s(o(v,'author'),'login')})`)),
  'gh-pr-view': structured(shape({ number: uint, title: string, state: ghState, author: ghActor, url: string }, {
    body: nullable(string), mergeable: oneOf('MERGEABLE','CONFLICTING','UNKNOWN'), reviews, statusCheckRollup: nullable(array(checkRow)),
  }), v => {
    const merge = v.mergeable === 'MERGEABLE' ? '[ok]' : v.mergeable === 'CONFLICTING' ? '[x]' : '?';
    let out = `${icon(s(v,'state'))} PR #${n(v,'number')}: ${s(v,'title')}\n  ${s(o(v,'author'),'login')}\n  ${s(v,'state')} | ${merge}\n`;
    const reviewRows = Array.isArray(v.reviews) ? v.reviews as Obj[] : object(v.reviews) ? a(v.reviews,'nodes') : [];
    const approved = reviewRows.filter(row => row.state === 'APPROVED').length, changes = reviewRows.filter(row => row.state === 'CHANGES_REQUESTED').length;
    if (approved || changes) out += `  Reviews: ${approved} approved, ${changes} changes requested\n`;
    if (Array.isArray(v.statusCheckRollup)) {
      const checks = a(v,'statusCheckRollup'), failed = checks.filter(checkFailed).length;
      out += `  Checks: ${checks.filter(checkPassed).length}/${checks.length} passed\n`;
      if (failed) out += `  [warn] ${failed} checks failed\n`;
    }
    out += `  ${s(v,'url')}\n`;
    if (v.body) { const body = markdown(s(v,'body')); out += body ? `\n${indented(body,'  ')}` : '\n  (body contained only badges/images/comments)\n'; }
    return out;
  }),
  'gh-pr-checks': input => {
    const checks = new Map<string,{status:string;row:string}>();
    for (const row of lines(input)) {
      if (!row.trim()) continue;
      const fields = row.split('\t').map(field => field.trim());
      if (fields.length !== 4 || !fields[0] || !fields[1]) return input;
      checks.set(JSON.stringify([fields[0],fields[3]]),{status:fields[1],row:row.trim()});
    }
    if (!checks.size) return input;
    const values = [...checks.values()], passed = values.filter(v => v.status === 'pass'), failed = values.filter(v => v.status === 'fail'), pending = values.filter(v => ['pending','*'].includes(v.status));
    const other = values.filter(v => !['pass','fail','pending','*'].includes(v.status));
    let out = `CI Checks Summary:\n  [ok] Passed: ${passed.length}\n  [FAIL] Failed: ${failed.length}\n`;
    if (pending.length) out += `  [pending] Pending: ${pending.length}\n`;
    if (other.length) out += `  [skip] Skipped/cancelled: ${other.length}\n`;
    if (failed.length) out += `\n  Failed checks:\n${failed.map(v => `    ${v.row}\n`).join('')}`;
    if (other.length) out += `\n  Other checks:\n${other.map(v => `    ${v.row}\n`).join('')}`;
    return out;
  },
  'gh-pr-status': structured(shape({ currentBranch: nullable(prStatus), createdBy: array(prStatus) }, { needsReview: array(prStatus) }), v => {
    let out = object(v.currentBranch) ? `Current Branch\n${statusEntry(v.currentBranch)}\n` : '';
    for (const [key,title] of [['createdBy','Your PRs'],['needsReview','Needs review']]) {
      if (!Array.isArray(v[key])) continue;
      const values = a(v,key);
      if (values.slice(5).some(row => a(row,'statusCheckRollup').some(checkFailed) || row.reviewDecision === 'CHANGES_REQUESTED')) return '';
      out += `${title} (${values.length}):\n${values.slice(0,5).map(statusEntry).join('')}${values.length > 5 ? `  … +${values.length - 5} more\n` : ''}`;
    }
    return out;
  }),
  'gh-issue-list': arrayFormat(shape({ number: uint, title: string, state: oneOf('OPEN','CLOSED') }, { author: ghActor }), values => forgeList('Issues',values,v => `  ${icon(s(v,'state'))} #${n(v,'number')} ${truncate(s(v,'title'),60)}`)),
  'gh-issue-view': structured(shape({ number: uint, title: string, state: oneOf('OPEN','CLOSED'), author: ghActor, url: string }, { body: nullable(string) }), v => issueView(v,false)),
  'gh-run-list': arrayFormat(shape({ databaseId: uint, name: string, status: oneOf('queued','in_progress','completed','waiting','pending','requested'), conclusion: nullable(oneOf('success','failure','cancelled','timed_out','action_required','neutral','skipped','stale','startup_failure','')) }, { createdAt: string }), values => `Workflow Runs\n${values.map(v => {
    const conclusion = s(v,'conclusion');
    const symbol = conclusion === 'success' ? '[ok]' : ['failure','timed_out','action_required','startup_failure'].includes(conclusion) ? '[FAIL]' : conclusion === 'cancelled' ? '[X]' : conclusion ? `[${conclusion}]` : v.status === 'in_progress' ? '[time]' : '[pending]';
    return `  ${symbol} ${truncate(s(v,'name'),50)} [${n(v,'databaseId')}]\n`;
  }).join('')}`),
  'gh-run-view': input => {
    const rows = lines(input); if (!rows.some(row => row.trim() === 'JOBS') || !rows.some(row => /^\s*(Status|Conclusion):/.test(row))) return input;
    let out = 'Workflow Run\n', jobs = false;
    for (const row of rows) {
      const trimmed = row.trim(); if (!trimmed) continue;
      if (trimmed === 'JOBS') { jobs = true; continue; }
      if (failure(trimmed) || trimmed.includes('[x]')) out += `${jobs ? '  [FAIL] ' : '  '}${trimmed}\n`;
      else if (!jobs || !/^✓\s+/.test(trimmed)) out += `  ${trimmed}\n`;
    }
    return out;
  },
  'gh-repo-view': structured(shape({ name: string, owner: ghActor, url: string, stargazerCount: uint, forkCount: uint, isPrivate: boolean }, { description: nullable(string) }), v => `${s(o(v,'owner'),'login')}/${s(v,'name')}\n  ${v.isPrivate ? '[private]' : '[public]'}\n${v.description ? `  ${truncate(s(v,'description'),80)}\n` : ''}  ${n(v,'stargazerCount')} stars | ${n(v,'forkCount')} forks\n  ${s(v,'url')}\n`),
};

const runnerBoilerplate = /^(?:Running with gitlab-runner|on .*system ID:|Using Docker executor|Using Shell|Running on |Preparing the|Preparing environment|Getting source from|Resolving secrets|Cleaning up|Uploading artifacts|Downloading artifacts|Runtime platform|Fetching changes with git|Initialized empty Git|Created fresh repository|Checking out |Skipping Git submodules)/;
const glabFilters: Record<string, Filter> = {
  'glab-mr-list': arrayFormat(glabMr, values => forgeList('Merge Requests',values,v => `  ${icon(s(v,'state'))} !${n(v,'iid')} ${truncate(s(v,'title'),60)} (${s(o(v,'author'),'username')})`)),
  'glab-mr-view': structured(shape({ iid: uint, title: string, state: glabState, author: glabActor, web_url: string, source_branch: string, target_branch: string }, {
    ...glabMetadata, description: nullable(string), labels: strings, reviewers: array(glabActor), merge_status: oneOf('can_be_merged','cannot_be_merged','unchecked','checking','cannot_be_merged_recheck','unknown'),
    head_pipeline: nullable(shape({ status: pipelineState }, ignored('id iid project_id sha ref source created_at updated_at web_url before_sha tag yaml_errors user started_at finished_at committed_at duration queued_duration coverage detailed_status'))),
    ...ignored('source_project_id target_project_id detailed_merge_status sha merge_commit_sha squash_commit_sha merge_error merge_when_pipeline_succeeds merge_after squash squash_on_merge should_remove_source_branch force_remove_source_branch allow_collaboration allow_maintainer_to_push blocking_discussions_resolved approvals_before_merge has_conflicts changes_count diff_refs first_contribution pipeline imported imported_from prepared_at'),
  }), v => {
    const merge = v.merge_status === 'can_be_merged' ? '[ok]' : v.merge_status === 'cannot_be_merged' ? '[conflict]' : '[?]';
    let out = `${icon(s(v,'state'))} MR !${n(v,'iid')}: ${s(v,'title')}\n  ${s(o(v,'author'),'username')}\n  ${s(v,'state')} | ${merge}\n  ${s(v,'source_branch')} -> ${s(v,'target_branch')}\n`;
    if (Array.isArray(v.labels) && v.labels.length) out += `  Labels: ${(v.labels as string[]).join(', ')}\n`;
    if (a(v,'reviewers').length) out += `  Reviewers: ${a(v,'reviewers').map(row => `@${s(row,'username')}`).join(', ')}\n`;
    if (object(v.head_pipeline)) out += `  Pipeline: ${pipelineIcon(s(v.head_pipeline,'status'))} ${s(v.head_pipeline,'status')}\n`;
    out += `  ${s(v,'web_url')}\n`;
    if (v.description) { const desc = markdown(s(v,'description')); if (desc) out += `\n${indented(desc,'  ')}`; }
    return out;
  }),
  'glab-issue-list': arrayFormat(shape({ iid: uint, title: string, state: oneOf('opened','closed') }, glabIssueMetadata), values => forgeList('Issues',values,v => `  ${icon(s(v,'state'))} #${n(v,'iid')} ${truncate(s(v,'title'),60)}`)),
  'glab-issue-view': structured(shape({ iid: uint, title: string, state: oneOf('opened','closed'), author: glabActor, web_url: string }, glabIssueMetadata), v => issueView(v,true)),
  'glab-ci-list': arrayFormat(shape({ id: uint, status: pipelineState, ref: string }, ignored('iid project_id sha source created_at updated_at web_url name')), values => forgeList('Pipelines',values,v => `  ${pipelineIcon(s(v,'status'))} #${n(v,'id')} ${s(v,'status')} (${s(v,'ref')})`,10)),
  'glab-ci-status': input => {
    let recognized = false;
    const out = lines(input).filter(row => row.trim()).map(row => {
      const trimmed = row.trim();
      const status = /\bfailed\b/.test(trimmed) ? 'failed' : /\b(?:passed|success)\b/.test(trimmed) ? 'success' : /\brunning\b/.test(trimmed) ? 'running' : /\bpending\b/.test(trimmed) ? 'pending' : /\bcancell?ed\b/.test(trimmed) ? 'canceled' : '';
      if (status) recognized = true;
      return `${status ? pipelineIcon(status) : ' '} ${trimmed}\n`;
    }).join('');
    return recognized ? out : input;
  },
  'glab-ci-trace': input => {
    if (!/Running with gitlab-runner|section_(?:start|end):\d+:/.test(input)) return input;
    const text = clean(input).replace(/\[[\d;]+[A-Za-z]/g,'').replace(/section_(?:start|end):\d+:[a-z0-9_]+(?:\[0K)*/g,'');
    const kept = lines(text).map(row => row.trim()).filter(row => row && (!runnerBoilerplate.test(row) || failure(row)));
    return kept.length ? `${kept.join('\n')}\n` : input;
  },
  'glab-release-list': input => {
    const rows = lines(input).filter(row => row.trim()), header = rows.findIndex(row => /^(?:Name|NAME)\t(?:Tag|TAG)\t(?:Created|CREATED)$/.test(row.trim()));
    if (header < 0 || rows.slice(0,header).some(row => !/^Showing \d+ releases/.test(row))) return input;
    const data = rows.slice(header + 1).map(row => row.trim().split('\t').map(field => field.trim()));
    if (!data.length || data.some(row => row.length !== 3 || row.some(field => !field))) return input;
    return `Releases\n${data.slice(0,20).map(([name,tag,created]) => `  ${name}${name === tag ? '' : ` [${tag}]`} (${created})\n`).join('')}${data.length > 20 ? `  … +${data.length - 20} more\n` : ''}`;
  },
  'glab-release-view': input => {
    if (!/^SOURCES\s*$/m.test(input)) return input;
    // Release text can contain code; retain those snapshots rather than treating
    // a source heading or image inside a fenced example as release chrome.
    if (input.includes('```') || input.includes('~~~')) return input;
    let sources = false;
    const kept: string[] = [];
    for (const row of lines(input)) {
      const trimmed = row.trim();
      if (trimmed === 'SOURCES') { sources = true; continue; }
      if (sources && /^https?:\/\/\S+$/.test(trimmed)) continue;
      sources = false;
      if (/^!\[[^\]]*\]\([^)]*\)$/.test(trimmed) || (trimmed.startsWith('Image:') && trimmed.includes('→')) || /^<!--.*-->$/.test(trimmed) || /^-{3,}$/.test(trimmed)) continue;
      kept.push(row);
    }
    return kept.join('\n').replace(/\n{3,}/g,'\n\n').trim() || input;
  },
};

const branchName = '[a-zA-Z0-9/_.\\-+@]+';
const branchRow = (action: string): RegExp => new RegExp(`^${action}\\s+branch\\s+[\\x60"']?(${branchName})[\\x60"']?[.!]?$`);
const graphNode = (row: string): boolean => /^[◉○◯◆●@*]/.test(row.replace(/^│*/,'').replace(/^\|*/,'').trimStart());
const gtFilters: Record<string, Filter> = {
  'gt-log': input => {
    const rows = lines(input.trim()); if (!rows.some(graphNode)) return input;
    let count = 0; const out: string[] = [];
    for (const [index,row] of rows.entries()) {
      if (graphNode(row)) count++;
      const text = row.replace(/<?\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b>?/g,'').trimEnd();
      out.push(truncate(text,120));
      if (count >= 15) { const remaining = rows.slice(index + 1).filter(graphNode).length; if (remaining) out.push(`... +${remaining} more entries`); break; }
    }
    return out.join('\n');
  },
  'gt-submit': input => {
    const pushed: string[] = [], prs: string[] = [];
    for (const row of lines(input).map(row => row.trim()).filter(Boolean)) {
      const push = branchRow('(?:Pushed|pushed)').exec(row), pr = /^(Created|Updated)\s+pull\s+request\s+#(\d+)\s+for\s+([^\s:]+)(?::\s*(\S+))?$/.exec(row);
      if (push) pushed.push(push[1]);
      else if (pr) prs.push(`${pr[1].toLowerCase()} PR #${pr[2]} ${pr[3]}${pr[4] ? ` ${pr[4]}` : ''}`);
      else return input;
    }
    return [...(pushed.length ? [`pushed ${pushed.join(', ')}`] : []), ...prs].join('\n') || input;
  },
  'gt-sync': input => {
    let synced = 0; const deleted: string[] = [];
    for (const row of lines(input).map(row => row.trim()).filter(Boolean)) {
      const removed = branchRow('(?:Deleted|deleted)').exec(row);
      if (branchRow('Synced').test(row) || /^Synced with remote(?:\s+\S+)?[.!]?$/.test(row)) synced++;
      else if (removed) deleted.push(removed[1]); else return input;
    }
    const parts = [...(synced ? [`${synced} synced`] : []), ...(deleted.length ? [`${deleted.length} deleted (${deleted.join(', ')})`] : [])];
    return parts.length ? `ok sync: ${parts.join(', ')}` : input;
  },
  'gt-restack': input => {
    const rows = lines(input).map(row => row.trim()).filter(Boolean);
    return rows.length && rows.every(row => branchRow('(?:Restacked|Rebased)').test(row)) ? `ok restacked ${rows.length} branches` : input;
  },
  'gt-create': input => {
    const rows = lines(input).map(row => row.trim()).filter(Boolean);
    const match = rows.length === 1 ? branchRow('(?:Created|created)').exec(rows[0]) : null;
    return match ? `ok created ${match[1]}` : input;
  },
};

export const cloudFilters: Record<string, Filter> = { ...awsFilters, ...ghFilters, ...glabFilters, ...gtFilters };

const awsRoutes: Record<string,string> = {
  'sts get-caller-identity':'sts-identity', 's3 ls':'s3-ls', 'ec2 describe-instances':'ec2-instances', 'ecs list-services':'ecs-list-services',
  'ecs describe-services':'ecs-describe-services', 'rds describe-db-instances':'rds-instances', 'cloudformation list-stacks':'cfn-list-stacks',
  'cloudformation describe-stacks':'cfn-describe-stacks', 'cloudformation describe-stack-events':'cfn-events', 'logs get-log-events':'logs-events',
  'logs filter-log-events':'logs-events', 'lambda list-functions':'lambda-list', 'lambda get-function':'lambda-get', 'iam list-roles':'iam-roles',
  'iam list-users':'iam-users', 'dynamodb scan':'dynamodb-items', 'dynamodb query':'dynamodb-items', 'ecs describe-tasks':'ecs-tasks',
  'ec2 describe-security-groups':'security-groups', 's3api list-objects-v2':'s3-objects', 'eks describe-cluster':'eks-cluster',
  'sqs receive-message':'sqs-messages', 'dynamodb get-item':'dynamodb-get-item', 'logs get-query-results':'logs-query-results',
  's3 sync':'s3-transfer', 's3 cp':'s3-transfer', 'secretsmanager get-secret-value':'secrets-get',
};
export function matchCloudFilter(argv: string[]): string | undefined {
  const [command,...args] = argv;
  if (!['aws','gh','glab','gt'].includes(command)) return undefined;
  const formatFlags = command === 'aws' ? ['--query','--generate-cli-skeleton','--cli-input-json','--cli-input-yaml'] : ['--json','--jq','--template','--web','--comments','--log','--log-failed','--output','--output-format','--format'];
  if (args.some(arg => ['--help','-h','--version'].includes(arg) || formatFlags.some(flag => arg === flag || arg.startsWith(`${flag}=`)))) return undefined;
  if (command === 'glab' && args.some(arg => /^-[Fo]/.test(arg))) return undefined;
  if (command === 'gh' && args.some(arg => /^-[qt]/.test(arg))) return undefined;
  if (command === 'aws') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--output' && args[i + 1] !== 'json') return undefined;
      if (args[i].startsWith('--output=') && args[i] !== '--output=json') return undefined;
    }
  }
  let index = 0;
  const valued = command === 'aws' ? ['--profile','--region','--endpoint-url','--output','--color','--ca-bundle','--cli-read-timeout','--cli-connect-timeout'] : command === 'gt' ? ['--cwd'] : ['--repo','-R'];
  const toggles = command === 'aws' ? ['--debug','--no-verify-ssl','--no-paginate','--no-sign-request','--no-cli-pager','--cli-auto-prompt','--no-cli-auto-prompt'] : command === 'gt' ? ['--no-interactive','--quiet','--no-verify'] : [];
  while (index < args.length && args[index].startsWith('-')) {
    const arg = args[index], equals = arg.indexOf('=');
    if (equals > 0 && valued.includes(arg.slice(0,equals)) && arg.slice(equals + 1)) index++;
    else if (valued.includes(arg) && args[index + 1] && !args[index + 1].startsWith('-')) index += 2;
    else if (['gh','glab'].includes(command) && /^-R.+/.test(arg)) index++;
    else if (toggles.includes(arg)) index++;
    else return undefined;
  }
  const rest = args.slice(index), [group, action] = rest;
  if (command === 'aws') {
    if (!group || !action || action.startsWith('-')) return undefined;
    const name = awsRoutes[`${group} ${action}`];
    return name ? `aws-${name}` : /^(?:describe-|list-|get-)/.test(action) || ['scan','query','receive-message'].includes(action) ? 'aws-json' : undefined;
  }
  if (command === 'gt') {
    if (group === 'log' && rest.some(arg => arg === '--short' || arg.startsWith('--short=') || arg === '-s')) return undefined;
    const name = `gt-${group}`; return Object.hasOwn(gtFilters,name) ? name : undefined;
  }
  const name = `${command}-${group}-${action ?? (command === 'gh' && group === 'repo' ? 'view' : '')}`;
  return Object.hasOwn(cloudFilters,name) ? name : undefined;
}
