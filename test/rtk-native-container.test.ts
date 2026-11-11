// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFilters,matchNativeFilter } from '../src/vendor/rtk-native.ts';
const cases:[string,string,string][]=[
 ['docker-ps','0123456789abcdef\tweb\tUp 2 hours\tregistry/nginx:latest\t0.0.0.0:8080->80/tcp\n','[docker] 1 containers:\n  0123456789ab web (nginx:latest) Up 2 hours [8080]\n'],
 ['docker-images','nginx:latest\t100MB\npostgres:16\t2GB\n','[docker] 2 images (2.1GB)\n  nginx:latest [100MB]\n  postgres:16 [2GB]\n'],
 ['compose-ps','web\tregistry/nginx:latest\tUp 2 hours\t0.0.0.0:8080->80/tcp\n','[compose] 1 services:\n  web (nginx:latest) Up 2 hours [8080]'],
 ['compose-build','[+] Building 2.3s (2/2) FINISHED\n => [web 1/2] FROM nginx\n => [web 2/2] COPY . .\n','[compose] [+] Building 2.3s (2/2) FINISHED\n  Services: web\n  Steps: 2'],
 ['kube-pods',JSON.stringify({kind:'PodList',items:[{metadata:{name:'web',namespace:'prod'},status:{phase:'Running',containerStatuses:[{restartCount:2}]}}]}),'1 pods: 1, 2 restarts\n'],
 ['kube-services',JSON.stringify({kind:'ServiceList',items:[{metadata:{name:'web',namespace:'prod'},spec:{type:'ClusterIP',ports:[{port:80,targetPort:8080}]}}]}),'1 services:\n  prod/web ClusterIP [80→8080]\n'],
];
for(const [name,input,expected] of cases)test(`${name} source format`,()=>assert.equal(nativeFilters[name]?.(input),expected));
test('Kubernetes services retain named targets and default only omitted targets', () => {
  const input = JSON.stringify({kind: 'ServiceList', items: [{metadata: {name: 'web', namespace: 'prod'},
    spec: {type: 'ClusterIP', ports: [
      {port: 80, targetPort: 'http'}, {port: 443, targetPort: 8443}, {port: 8080}, {port: 9000, targetPort: 9000},
    ]}}]});
  assert.equal(nativeFilters['kube-services'](input), '1 services:\n  prod/web ClusterIP [80→http,443→8443,8080,9000]\n');
});
test('Kubernetes services preserve malformed targets unchanged', () => {
  for (const targetPort of [null, false, {}, [], -1, 1.5]) {
    const input = JSON.stringify({kind: 'ServiceList', items: [{metadata: {name: 'web'},
      spec: {type: 'ClusterIP', ports: [{port: 80, targetPort}]}}]});
    assert.equal(nativeFilters['kube-services'](input), input);
  }
});
test('docker default table cannot impersonate injected tab-separated output',()=>{
 assert.equal(matchNativeFilter(['docker','ps']),undefined);
 assert.equal(matchNativeFilter(['docker','ps','--format','{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}']),'docker-ps');
 const raw='CONTAINER ID  IMAGE  COMMAND\n01234567      app    start\n';assert.equal(nativeFilters['docker-ps']?.(raw),raw);
});
test('malformed kubernetes objects remain unchanged',()=>{
 for(const name of ['kube-pods','kube-services']){const raw='{"items":[{}]}';assert.equal(nativeFilters[name]?.(raw),raw);}
});

test('Kubernetes preserves waiting and unready container details regardless of reason', () => {
  const running = {name: 'sidecar', ready: true, restartCount: 0, state: {running: {startedAt: '2026-11-10T00:00:00Z'}}};
  for (const phase of ['Running', 'Pending']) {
    for (const status of [
      ...['ImagePullBackOff', 'ErrImagePull', 'ContainerCreating', 'UnknownReason'].map(reason => ({
        name: 'app', restartCount: 0, state: {waiting: {reason, message: 'Container is not available'}},
      })),
      {...running, name: 'app', ready: false},
    ]) {
      const input = JSON.stringify({kind: 'PodList', items: [{metadata: {name: 'web', namespace: 'prod'},
        status: {phase, containerStatuses: [running, status]}}]});
      assert.equal(nativeFilters['kube-pods'](input), input);
    }
  }
});

test('Kubernetes still summarizes ready running containers', () => {
  const input = JSON.stringify({kind: 'PodList', items: [{metadata: {name: 'web', namespace: 'prod'}, status: {
    phase: 'Running', containerStatuses: [{name: 'app', ready: true, restartCount: 2, state: {running: {}}}],
    conditions: [{type: 'Ready', status: 'True'}, {type: 'DisruptionTarget', status: 'False'}],
  }}]});
  assert.equal(nativeFilters['kube-pods'](input), '1 pods: 1, 2 restarts\n');
});

test('Kubernetes preserves Pod readiness failures and malformed conditions', () => {
  for (const conditions of [
    ...['False', 'Unknown'].map(status => [{type: 'ContainersReady', status: 'True'},
      {type: 'Ready', status, reason: 'ReadinessGatesNotReady', message: 'Load balancer readiness gate has not passed'}]),
    null, {}, [null], [{type: 'Ready'}], [{status: 'True'}], [{type: 'Ready', status: 'unrecognized'}],
  ]) {
    const input = JSON.stringify({kind: 'PodList', items: [{metadata: {name: 'web', namespace: 'prod'}, status: {
      phase: 'Running', conditions,
      containerStatuses: [{name: 'app', ready: true, restartCount: 0, state: {running: {}}}],
    }}]});
    assert.equal(nativeFilters['kube-pods'](input), input);
  }
});
