// SPDX-License-Identifier: Apache-2.0
// Cases adapted from RTK 0.49.0 at 653efb6ed02bd287d686c50e830dd1009356904f,
// src/cmds/system/find_cmd.rs; additional synthetic cases exercise its pure renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFindByDir, displayFindOrdered, buildCappedFindListing, formatFindFilteredHint, renderFind } from '../src/vendor/rtk-native-find.ts';

test('find display order follows directory groups and preserves order inside each group',()=>{
  assert.deepEqual(displayFindOrdered(['zebra.txt','logs/a.txt','alpha.txt']),['zebra.txt','alpha.txt','logs/a.txt']);
  assert.deepEqual(displayFindOrdered(['.','a.rs']),['.','a.rs']);
  const paths=Array.from({length:30},(_,i)=>[ `logs/f${String(i+1).padStart(2,'0')}.txt`, `logs-old/f${String(i+1).padStart(2,'0')}.txt` ]).flat().sort();
  const ordered=displayFindOrdered(paths);
  assert.equal(ordered[0],'logs/f01.txt');
  assert.deepEqual(ordered.slice(50),Array.from({length:10},(_,i)=>`logs-old/f${i+21}.txt`));
});

test('find grouping uses POSIX path components without resolving parent components',()=>{
  assert.deepEqual([...groupFindByDir(['a//b/c.txt','a/../d.txt','./e.txt','folder/','/','..'])],[
    ['a//b',['c.txt']],['a/..',['d.txt']],['.',['e.txt','folder','/','..']],
  ]);
});

test('find capped listing preserves pinned terminators and explicit omission count',()=>{
  assert.equal(buildCappedFindListing(['a.rs','b.rs'],10),'a.rs\nb.rs\n');
  assert.equal(buildCappedFindListing(['a.rs','b.rs','c.rs','d.rs'],2),'a.rs\nb.rs\n+2 more\n');
  assert.equal(buildCappedFindListing(['a.rs','b.rs'],2),'a.rs\nb.rs\n');
  assert.equal(buildCappedFindListing([],0),'\n');
  assert.equal(buildCappedFindListing(['a.rs'],0),'\n+1 more\n');
});

test('find filtered disclosure names the capped count and only uses supplied recall text',()=>{
  assert.equal(formatFindFilteredHint([]),undefined);
  assert.equal(formatFindFilteredHint(['secret.txt','.hidden/h.txt']),'... (2 filtered)');
  assert.equal(formatFindFilteredHint(Array.from({length:1001},(_,i)=>String(i))),'... (1000+ filtered)');
  assert.equal(formatFindFilteredHint(['a'],'existing recall hint'),'... (1 filtered)\nexisting recall hint');
});

test('find renderer retains the capped baseline when a grouped summary costs more',()=>{
  assert.equal(renderFind(['a.rs'],{maxResults:10}),'a.rs\n');
  assert.equal(renderFind(['d.rs','c.rs','b.rs','a.rs'],{maxResults:2}),'a.rs\nb.rs\n+2 more\n');
  assert.equal(renderFind([],{maxResults:10}),'');
  assert.equal(renderFind([],{maxResults:10,filtered:['.secret']}),'... (1 filtered)\n');
});

test('find grouped renderer emits source directory groups and extension counts',()=>{
  const dir='shared/deep/very/long/directory';
  assert.equal(renderFind([`${dir}/c.txt`,`${dir}/b.rs`,`${dir}/a.rs`],{maxResults:10}),
    `3F 1D:\n\n${dir}/ a.rs b.rs c.txt\n\next: .rs(2) .txt(1)\n`);
});

test('find renderer caps individual files and leaves the input array unchanged',()=>{
  const dir='shared/deep/very/long/directory/with/more/components';
  const paths=Array.from({length:6},(_,i)=>`${dir}/f${i}.rs`).reverse();
  const before=paths.slice();
  assert.equal(renderFind(paths,{maxResults:3}),'6F 1D:\n\n...d/deep/very/long/directory/with/more/components/ f0.rs f1.rs f2.rs\n+3 more\n');
  assert.deepEqual(paths,before);
});

test('find renderer clips long directory labels by Unicode characters',()=>{
  const dir='é'.repeat(60);
  const paths=Array.from({length:4},(_,i)=>`${dir}/f${i}.rs`);
  assert.equal(renderFind(paths,{maxResults:3}),`4F 1D:\n\n...${'é'.repeat(47)}/ f0.rs f1.rs f2.rs\n+1 more\n`);
});

test('find renderer retains disclosure and caller supplied hints in either guard branch',()=>{
  assert.equal(renderFind(['b','a'],{maxResults:1,overflowHint:'existing recall'}),'a\n+1 more\nexisting recall\n');
  assert.equal(renderFind(['b','a'],{maxResults:1,maxExplicit:true,overflowHint:'existing recall'}),'a\n+1 more\n');
  assert.equal(renderFind(['a'],{maxResults:1,filtered:['.x'],filteredHint:'hidden recall'}),'a\n... (1 filtered)\nhidden recall\n');
});

test('find extension summary handles dotfiles, trailing dots and the top-five cap',()=>{
  const dir='shared/deep/very/long/directory';
  const names=['a.rs','b.rs','.env','c.','d.a','e.b','f.c','g.d'];
  assert.equal(renderFind(names.map(name=>`${dir}/${name}`),{maxResults:20}),
    `8F 1D:\n\n${dir}/ .env a.rs b.rs c. d.a e.b f.c g.d\n\next: .rs(2) .(1) .a(1) .b(1) .c(1)\n`);
});

test('find zero cap retains the source empty-list prefix and every omitted count',()=>{
  assert.equal(renderFind(['a.rs','b.rs'],{maxResults:0}),'\n+2 more\n');
});

test('find invalid caps do not remove supplied paths',()=>{
  for(const maxResults of [-1,NaN,Infinity,0.5]){
    assert.equal(renderFind(['b','a'],{maxResults}),'b\na\n');
    assert.equal(buildCappedFindListing(['b','a'],maxResults),'b\na\n');
  }
});
