// Copyright 2026 RTK AI Labs. Apache-2.0; modified by cc-clean.
// Synthetic fixtures derived from the pinned AWS/gh/glab/gt pure formatters.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFilters, matchCloudFilter } from '../src/vendor/rtk-native-cloud.ts';

const identity = { Account: '123', Arn: 'arn:aws:iam::123:user/alice', UserId: 'id' };
const pr = { number: 1, title: 'Fix builds', state: 'OPEN', author: { login: 'alice' } };
const mr = { iid: 1, title: 'Fix builds', state: 'opened', author: { username: 'alice' } };
const fixtures: [string, string[], unknown, string][] = [
  ['aws-sts-identity', ['aws','sts','get-caller-identity'], identity, 'AWS: 123 arn:aws:iam::123:user/alice'],
  ['aws-s3-ls', ['aws','s3','ls'], Array.from({length:31},(_,i)=>`2026-11-10 10:00:00 ${i} file${i}`).join('\n'), '… +1 more items'],
  ['aws-ec2-instances', ['aws','ec2','describe-instances'], {Reservations:[{Instances:[{InstanceId:'i-1',InstanceType:'t3.micro',State:{Name:'running',Code:16}}]}]}, 'EC2: 1 instances\n  i-1 running t3.micro - pub:- vpc:- subnet:- sg:[-] (-)'],
  ['aws-ecs-list-services', ['aws','ecs','list-services'], {serviceArns:['arn:aws:ecs:region:123:service/cluster/api']}, 'api'],
  ['aws-ecs-describe-services', ['aws','ecs','describe-services'], {services:[{serviceName:'api',status:'ACTIVE',runningCount:2,desiredCount:3,launchType:'FARGATE'}]}, 'api ACTIVE 2/3 (FARGATE)'],
  ['aws-rds-instances', ['aws','rds','describe-db-instances'], {DBInstances:[{DBInstanceIdentifier:'db',Engine:'postgres',EngineVersion:'16',DBInstanceClass:'db.t3.micro',DBInstanceStatus:'available',Endpoint:{Address:'db.local',Port:5432}}]}, 'db postgres 16 db.t3.micro available db.local:5432'],
  ['aws-cfn-list-stacks', ['aws','cloudformation','list-stacks'], {StackSummaries:[{StackName:'app',StackStatus:'CREATE_COMPLETE',CreationTime:'2026-11-10T00:00:00Z'}]}, 'app CREATE_COMPLETE 2026-11-10'],
  ['aws-cfn-describe-stacks', ['aws','cloudformation','describe-stacks'], {Stacks:[{StackName:'app',StackStatus:'UPDATE_COMPLETE',LastUpdatedTime:'2026-11-10T00:00:00Z',Outputs:[{OutputKey:'url',OutputValue:'https://example.com'}]}]}, 'app UPDATE_COMPLETE 2026-11-10\n  url=https://example.com'],
  ['aws-cfn-events', ['aws','cloudformation','describe-stack-events'], {StackEvents:[{ResourceStatus:'CREATE_FAILED',LogicalResourceId:'Api',ResourceType:'AWS::Lambda::Function',Timestamp:'2026-11-10T00:00:00Z',ResourceStatusReason:'denied'}]}, 'CloudFormation: 1 events (1 failed, 0 successful)\n--- FAILURES ---\n  2026-11-10 Api Lambda::Function CREATE_FAILED REASON: denied'],
  ['aws-logs-events', ['aws','logs','get-log-events'], {events:[{timestamp:1000,message:'hello\n'}]}, '1970-01-01 00:00:01 hello'],
  ['aws-lambda-list', ['aws','lambda','list-functions'], {Functions:[{FunctionName:'api',Runtime:'nodejs24.x',MemorySize:128,Timeout:3}]}, 'api nodejs24.x 128MB 3s active'],
  ['aws-lambda-get', ['aws','lambda','get-function'], {Configuration:{FunctionName:'api',Runtime:'nodejs24.x',Handler:'index.handler',MemorySize:128,Timeout:3,LastModified:'2026-11-10T00:00:00Z',Layers:[{Arn:'arn:aws:lambda:x:1:layer:common:2'}]}}, 'api nodejs24.x index.handler 128MB 3s active 2026-11-10\n  layers: common:2'],
  ['aws-iam-roles', ['aws','iam','list-roles'], {Roles:[{RoleName:'runner',CreateDate:'2026-11-10T00:00:00Z',AssumeRolePolicyDocument:{Statement:[{Principal:{Service:'lambda.amazonaws.com'}}]}}]}, 'runner 2026-11-10 assume:[lambda.amazonaws.com]'],
  ['aws-iam-users', ['aws','iam','list-users'], {Users:[{UserName:'alice',CreateDate:'2026-11-10T00:00:00Z'}]}, 'alice created:2026-11-10'],
  ['aws-dynamodb-items', ['aws','dynamodb','scan'], {Items:[{name:{S:'Alice'},age:{N:'42'}}],Count:1,ScannedCount:2,ConsumedCapacity:{CapacityUnits:0.5}}, 'Count: 1/2\nCapacity: 0.5 RCU\n{"age":42,"name":"Alice"}'],
  ['aws-ecs-tasks', ['aws','ecs','describe-tasks'], {tasks:[{taskArn:'arn:aws:ecs:x:1:task/cluster/123',lastStatus:'STOPPED',containers:[{name:'api',lastStatus:'STOPPED',exitCode:1}],stoppedReason:'crashed'}]}, '123 STOPPED containers:[api:STOPPED(exit:1)] reason:crashed'],
  ['aws-security-groups', ['aws','ec2','describe-security-groups'], {SecurityGroups:[{GroupName:'web',GroupId:'sg-1',IpPermissions:[{IpProtocol:'tcp',FromPort:80,ToPort:80,IpRanges:[{CidrIp:'0.0.0.0/0'}]}],IpPermissionsEgress:[{IpProtocol:'-1',IpRanges:[{CidrIp:'0.0.0.0/0'}]}]}]}, 'web (sg-1) ingress: tcp/80<-0.0.0.0/0 | egress: all<-0.0.0.0/0'],
  ['aws-s3-objects', ['aws','s3api','list-objects-v2'], {Contents:[{Key:'a.txt',Size:1024,LastModified:'2026-11-10T00:00:00Z'}]}, 'a.txt 1.0 KB 2026-11-10'],
  ['aws-eks-cluster', ['aws','eks','describe-cluster'], {cluster:{name:'prod',status:'ACTIVE',version:'1.31',endpoint:'https://eks.example'}}, 'prod ACTIVE k8s/1.31 https://eks.example'],
  ['aws-sqs-messages', ['aws','sqs','receive-message'], {Messages:[{MessageId:'1234567890',Body:'hello',ReceiptHandle:'opaque'}]}, '12345678 hello'],
  ['aws-dynamodb-get-item', ['aws','dynamodb','get-item'], {Item:{key:{S:'a'},empty:{NULL:true}}}, '{"empty":null,"key":"a"}'],
  ['aws-logs-query-results', ['aws','logs','get-query-results'], {status:'Complete',results:[[{field:'@message',value:'hello'},{field:'@ptr',value:'opaque'}]]}, 'Status: Complete\n@message=hello'],
  ['aws-s3-transfer', ['aws','s3','sync'], Array.from({length:10},(_,i)=>`upload: a${i} to s3://bucket/a${i}`).join('\n'), 'S3 transfer: 10 uploaded, 0 errors'],
  ['aws-secrets-get', ['aws','secretsmanager','get-secret-value'], {Name:'demo',SecretString:'{ "key": "synthetic" }'}, 'Name: demo\nSecret: {"key":"synthetic"}'],
  ['aws-json', ['aws','cloudwatch','describe-alarms'], '{ "Unknown": [9007199254740993, 1.234567890123456789] }', '{"Unknown":[9007199254740993,1.234567890123456789]}'],
  ['gh-pr-list', ['gh','pr','list'], [pr], 'Pull Requests\n  [open] #1 Fix builds (alice)\n'],
  ['gh-pr-view', ['gh','pr','view','1'], {...pr,url:'https://example.com/1',body:'<!--noise-->\nUseful',mergeable:'MERGEABLE',statusCheckRollup:[{conclusion:'FAILURE'}]}, '[open] PR #1: Fix builds\n  alice\n  OPEN | [ok]\n  Checks: 0/1 passed\n  [warn] 1 checks failed\n  https://example.com/1\n\n  Useful\n'],
  ['gh-pr-checks', ['gh','pr','checks'], 'build\tpass\t2s\thttps://example.com/build\nlint\tfail\t3s\thttps://example.com/lint\n', 'CI Checks Summary:\n  [ok] Passed: 1\n  [FAIL] Failed: 1\n\n  Failed checks:\n    lint\tfail\t3s\thttps://example.com/lint\n'],
  ['gh-pr-status', ['gh','pr','status'], {currentBranch:{number:1,title:'Fix builds',reviewDecision:'APPROVED'},createdBy:[]}, 'Current Branch\n  #1 Fix builds [APPROVED]\n\nYour PRs (0):\n'],
  ['gh-issue-list', ['gh','issue','list'], [{number:2,title:'Bug',state:'OPEN'}], 'Issues\n  [open] #2 Bug\n'],
  ['gh-issue-view', ['gh','issue','view','2'], {number:2,title:'Bug',state:'OPEN',author:{login:'alice'},body:'Details',url:'https://example.com/2'}, '[open] Issue #2: Bug\n  Author: @alice\n  Status: OPEN\n  URL: https://example.com/2\n\n  Description:\n    Details\n'],
  ['gh-run-list', ['gh','run','list'], [{databaseId:3,name:'CI',status:'completed',conclusion:'failure'}], 'Workflow Runs\n  [FAIL] CI [3]\n'],
  ['gh-run-view', ['gh','run','view','3'], 'Status: completed\nConclusion: failure\nJOBS\n[x] build failed\n✓ lint success\n', 'Workflow Run\n  Status: completed\n  Conclusion: failure\n  [FAIL] [x] build failed\n'],
  ['gh-repo-view', ['gh','repo','view'], {name:'repo',owner:{login:'alice'},description:'demo',url:'https://example.com/repo',stargazerCount:2,forkCount:1,isPrivate:false}, 'alice/repo\n  [public]\n  demo\n  2 stars | 1 forks\n  https://example.com/repo\n'],
  ['glab-mr-list', ['glab','mr','list'], [mr], 'Merge Requests\n  [open] !1 Fix builds (alice)\n'],
  ['glab-mr-view', ['glab','mr','view','1'], {...mr,web_url:'https://example.com/1',description:'Details',merge_status:'can_be_merged',source_branch:'fix',target_branch:'main',head_pipeline:{status:'failed'}}, '[open] MR !1: Fix builds\n  alice\n  opened | [ok]\n  fix -> main\n  Pipeline: [fail] failed\n  https://example.com/1\n\n  Details\n'],
  ['glab-issue-list', ['glab','issue','list'], [{iid:2,title:'Bug',state:'opened'}], 'Issues\n  [open] #2 Bug\n'],
  ['glab-issue-view', ['glab','issue','view','2'], {iid:2,title:'Bug',state:'opened',author:{username:'alice'},description:'Details',web_url:'https://example.com/2'}, '[open] Issue #2: Bug\n  Author: @alice\n  Status: opened\n  URL: https://example.com/2\n\n  Description:\n    Details\n'],
  ['glab-ci-list', ['glab','ci','list'], [{id:3,status:'failed',ref:'main'}], 'Pipelines\n  [fail] #3 failed (main)\n'],
  ['glab-ci-status', ['glab','ci','status'], 'build failed\n', '[fail] build failed\n'],
  ['glab-ci-trace', ['glab','ci','trace'], 'Running with gitlab-runner 17.0\nPreparing environment\n$ npm test\nFAIL example\n', '$ npm test\nFAIL example\n'],
  ['glab-release-list', ['glab','release','list'], 'Showing 1 releases\nName\tTag\tCreated\nRelease\tv1\t2026-11-10\n', 'Releases\n  Release [v1] (2026-11-10)\n'],
  ['glab-release-view', ['glab','release','view','v1'], 'Release v1\nSOURCES\nhttps://example.com/archive.zip\n\nNotes\n', 'Release v1\n\nNotes'],
  ['gt-log', ['gt','log'], '◉ feature <alice@example.com>\n│ detail\n○ main\n', '◉ feature\n│ detail\n○ main'],
  ['gt-submit', ['gt','submit'], 'Pushed branch feature\nCreated pull request #4 for feature: https://example.com/4\n', 'pushed feature\ncreated PR #4 feature https://example.com/4'],
  ['gt-sync', ['gt','sync'], 'Synced branch main\nDeleted branch old\n', 'ok sync: 1 synced, 1 deleted (old)'],
  ['gt-restack', ['gt','restack'], 'Restacked branch feature\nRebased branch next\n', 'ok restacked 2 branches'],
  ['gt-create', ['gt','create','feature'], 'Created branch feature\n', 'ok created feature'],
];

for (const [name, argv, value, expected] of fixtures) test(name, () => {
  assert.equal(matchCloudFilter(argv), name);
  const input = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const output = cloudFilters[name](input);
  if (name === 'aws-s3-ls') assert.ok(output.endsWith(expected));
  else assert.equal(output, expected);
});

test('every registered formatter has a positive fixture', () => {
  assert.deepEqual(Object.keys(cloudFilters).sort(), fixtures.map(([name])=>name).sort());
});

test('all formatters fail open on unknown, malformed and empty input', () => {
  for (const [name, filter] of Object.entries(cloudFilters)) for (const input of ['', '  unknown format\r\n', '{broken', '{"newSchema":true}']) {
    assert.equal(filter(input), input, `${name}: ${input}`);
  }
});

test('structured filters reject unknown fields and malformed trailing records', () => {
  for (const [name,,value] of fixtures) {
    if (typeof value === 'string') continue;
    const changed = Array.isArray(value) ? value.map(x=>({...x,newSchema:true})) : {...value as object,newSchema:true};
    const input = JSON.stringify(changed,null,2);
    assert.equal(cloudFilters[name](input), input, name);
  }
  const input = JSON.stringify([...Array.from({length:20},()=>pr),{...pr,number:'bad'}]);
  assert.equal(cloudFilters['gh-pr-list'](input),input);
});

test('preserves pagination, failures, pending resources, and review requests', () => {
  const scan = JSON.stringify({Items:[],Count:0,LastEvaluatedKey:{id:{S:'next'}}});
  assert.match(cloudFilters['aws-dynamodb-items'](scan), /paginated/);
  const failure = JSON.stringify({services:[],failures:[{arn:'a',reason:'denied'}]});
  assert.equal(cloudFilters['aws-ecs-describe-services'](failure),failure);
  const event = {ResourceStatus:'CREATE_IN_PROGRESS',LogicalResourceId:'Api',ResourceType:'AWS::Lambda::Function',Timestamp:'2026-11-10'};
  const pending = JSON.stringify({StackEvents:[event]});
  assert.equal(cloudFilters['aws-cfn-events'](pending),pending);
  const errors = Array.from({length:25},(_,i)=>({...event,ResourceStatus:'CREATE_FAILED',ResourceStatusReason:`failure-${i}`}));
  assert.match(cloudFilters['aws-cfn-events'](JSON.stringify({StackEvents:errors})),/failure-24/);
  const status = JSON.stringify({currentBranch:null,createdBy:[],needsReview:[{number:5,title:'Please review'}]});
  assert.match(cloudFilters['gh-pr-status'](status),/Needs review/);
});

test('Dynamo values preserve exact decimal digits, nested types and attribute names', () => {
  const input = '{"Item":{"N":{"S":"attribute named N"},"big":{"N":"900719925474099312345"},"decimal":{"N":"0.1234567890123456789"},"set":{"NS":["1","2.5"]},"nested":{"M":{"items":{"L":[{"BOOL":true},{"B":"YWJj"}]}}}}}';
  assert.equal(cloudFilters['aws-dynamodb-get-item'](input), '{"N":"attribute named N","big":900719925474099312345,"decimal":0.1234567890123456789,"nested":{"items":[true,"YWJj"]},"set":[1,2.5]}');
  for (const item of [{x:{Unknown:'value'}},{x:{N:'NaN'}},{x:{NULL:false}},{x:{S:'a',N:'2'}}]) {
    const raw = JSON.stringify({Item:item}); assert.equal(cloudFilters['aws-dynamodb-get-item'](raw),raw);
  }
});

test('preserves JSON numeric lexemes inside logs and secrets', () => {
  const secret = JSON.stringify({Name:'demo',SecretString:'{ "id": 9007199254740993 }'});
  assert.match(cloudFilters['aws-secrets-get'](secret),/9007199254740993/);
  const log = JSON.stringify({events:[{timestamp:1000,message:'{ "id": 9007199254740993 }'}]});
  assert.match(cloudFilters['aws-logs-events'](log),/9007199254740993/);
});

test('checks watch deduplicates latest status and retains unknown status text', () => {
  const output=cloudFilters['gh-pr-checks']('ci\tpending\t0s\turl\nci\tpass\t1s\turl\nother\tnew-state\t0s\tx\n');
  assert.match(output,/Passed: 1/); assert.doesNotMatch(output,/Pending:/); assert.match(output,/new-state/);
});

test('markdown preserves fenced source and unclosed fences', () => {
  const body='<!--noise-->\n~~~md\n![image](keep)\n~~~\n```html\n<!--keep-->';
  const output=cloudFilters['gh-issue-view'](JSON.stringify({...pr,url:'u',body}));
  assert.doesNotMatch(output,/noise/); assert.match(output,/!\[image\]\(keep\)/); assert.match(output,/<!--keep-->/);
});

test('text summaries preserve unknown and failure lines', () => {
  for (const name of ['gt-submit','gt-sync','gt-restack','gt-create']) {
    const sample=fixtures.find(x=>x[0]===name)![2] as string;
    assert.equal(cloudFilters[name](sample+'ERROR: denied\n'),sample+'ERROR: denied\n');
  }
  const transfer=fixtures.find(x=>x[0]==='aws-s3-transfer')![2] as string;
  const failed=transfer+'\n'+Array.from({length:12},(_,i)=>`error: failure-${i}`).join('\n');
  assert.match(cloudFilters['aws-s3-transfer'](failed),/failure-11/);
  assert.equal(cloudFilters['aws-s3-transfer'](transfer+'\nunknown info'),transfer+'\nunknown info');
  assert.equal(cloudFilters['glab-ci-trace']('Running with gitlab-runner\nUploading artifacts failed: denied\n'),'Uploading artifacts failed: denied\n');
});

test('routing honors global options and bypasses custom output / interactive forms', () => {
  assert.equal(matchCloudFilter(['aws','--profile','dev','--region=us-east-1','sts','get-caller-identity']),'aws-sts-identity');
  assert.equal(matchCloudFilter(['gh','-R','org/repo','pr','list']),'gh-pr-list');
  assert.equal(matchCloudFilter(['glab','--repo=org/repo','mr','list']),'glab-mr-list');
  assert.equal(matchCloudFilter(['aws','logs','filter-log-events']),'aws-logs-events');
  assert.equal(matchCloudFilter(['aws','dynamodb','query']),'aws-dynamodb-items');
  for (const argv of [['gh','pr','view','--web'],['gh','pr','list','--json','number'],['gh','run','view','--log-failed'],['glab','mr','view','--comments'],['glab','mr','list','-F','json'],['aws','ec2','describe-instances','--query','Reservations'],['aws','ec2','describe-instances','--output','table'],['gt','log','--short'],['aws','--unknown','x','sts','get-caller-identity'],['gh','api','repos/a/b']]) assert.equal(matchCloudFilter(argv),undefined,argv.join(' '));
});

test('rejects unknown nested schemas and retains actionable records beyond list caps', () => {
  for (const [name,value] of [
    ['gh-pr-list',[{...pr,author:{login:'alice',newSchema:true}}]],
    ['glab-mr-view',{...mr,web_url:'u',source_branch:'fix',target_branch:'main',head_pipeline:{status:'failed',newSchema:true}}],
    ['aws-cfn-list-stacks',{StackSummaries:[{StackName:'x',StackStatus:'CREATE_COMPLETE'}]}],
    ['aws-ecs-tasks',{tasks:[{taskArn:'a',lastStatus:'STOPPED',containers:[{name:'x',lastStatus:'STOPPED',newSchema:true}]}]}],
  ] as [string,unknown][]) {
    const input=JSON.stringify(value); assert.equal(cloudFilters[name](input),input,name);
  }
  const events=Array.from({length:51},(_,i)=>({timestamp:1000,message:i===50?'ERROR: tail failure':'normal'}));
  const logs=JSON.stringify({events}); assert.equal(cloudFilters['aws-logs-events'](logs),logs);
  const pipelines=JSON.stringify(Array.from({length:11},(_,i)=>({id:i,status:i===10?'failed':'success',ref:'main'})));
  assert.equal(cloudFilters['glab-ci-list'](pipelines),pipelines);
  const stacks=JSON.stringify({Stacks:[{StackName:'x',StackStatus:'CREATE_FAILED',CreationTime:'2026-11-10',StackStatusReason:'permission denied'}]});
  assert.match(cloudFilters['aws-cfn-describe-stacks'](stacks),/permission denied/);
});

test('recognizes attached global options and retains unrecognized job text', () => {
  assert.equal(matchCloudFilter(['gh','-Rorg/repo','pr','list']),'gh-pr-list');
  assert.equal(matchCloudFilter(['glab','-Rorg/repo','mr','list']),'glab-mr-list');
  for (const argv of [['gh','pr','list','--json=number'],['glab','mr','list','-Fjson'],['aws','ec2','describe-instances','--output=table'],['gt','log','--short=true']]) assert.equal(matchCloudFilter(argv),undefined);
  const input='Status: completed\nConclusion: failure\nJOBS\n[x] build failed\nartifact success requires review\n';
  assert.match(cloudFilters['gh-run-view'](input),/artifact success requires review/);
});
