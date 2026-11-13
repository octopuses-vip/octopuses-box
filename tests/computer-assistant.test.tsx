import assert from "node:assert/strict";
import test from "node:test";
import { parseComputerAction } from "../src/computer/actions";
import { runComputerAssistant, type ComputerRuntime } from "../src/computer/runner";
import { useComputerSettings, useComputerRun, stopComputerRun } from "../src/computer/settings";
import { useAppStore } from "../src/app/state";
import type { RemoteModel } from "../src/app/types";

test("动作参数拒绝无效坐标、快捷键、空文本和任意脚本", () => {
  for (const value of [{ action:"script" },{ action:"click",x:100,y:0 },{ action:"scroll",amount:100 },{ action:"type",text:"" },{ action:"key",key:"shell" }]) assert.throws(()=>parseComputerAction(JSON.stringify({reason:"测试",...value})));
  assert.equal(parseComputerAction('{"action":"type","text":"中文🙂","reason":"填写"}').text,"中文🙂");
});

test("独立模型按截图闭环验证；审批拒绝、取消、并发与步骤上限均停止操作", async () => {
  const settings = useComputerSettings.getState(); const state = useAppStore.getState();
  useComputerSettings.setState({enabled:true,modelCode:"vision",maxSteps:1,allowedApps:"com.apple.TextEdit"});
  useAppStore.setState({remoteModels:[{code:"vision",baseUrl:"https://vision.example/v1",apiKey:"",supportsImages:true} as RemoteModel]});
  const goal={goal:"输入你好",app:"com.apple.TextEdit"};
  let captures=0; const actions:string[]=[]; let decisions=0;
  const io:ComputerRuntime={
    capture:async()=>({ok:true,output:"屏幕",mime:"image/png",base64:"test",width:100,height:100}),
    execute:async(_app,a)=>{actions.push(a.action);},
    decide:async(options)=>{assert.equal(options.model,"vision"); decisions++; return JSON.stringify(decisions===1?{action:"type",text:"你好",reason:"填写"}:{action:"done",reason:"看到你好"});},
  };
  const capture=io.capture;io.capture=async()=>{captures++;return capture();};
  try {
    const success=await runComputerAssistant(goal,new AbortController().signal,async()=>true,io);
    assert.equal(success.ok,true);assert.equal(captures,2);assert.deepEqual(actions,["activate","type"]);
    actions.length=0;
    assert.equal((await runComputerAssistant(goal,new AbortController().signal,async()=>false,io)).ok,false);
    assert.deepEqual(actions,[]);
    io.decide=async()=>JSON.stringify({action:"wait",reason:"等待"});
    assert.match((await runComputerAssistant(goal,new AbortController().signal,async()=>true,io)).output,/步上限/);
    actions.length=0;
    let started!:()=>void;const pending=new Promise<void>(r=>{started=r;});
    const stopped=runComputerAssistant(goal,new AbortController().signal,async()=>{started();return new Promise<boolean>(()=>{});},io);
    await pending;
    await assert.rejects(runComputerAssistant(goal,new AbortController().signal,async()=>true,io),/另一项/);
    stopComputerRun();assert.equal((await stopped).ok,false);assert.equal(useComputerRun.getState().running,false);assert.deepEqual(actions,[]);
    await assert.rejects(runComputerAssistant({...goal,app:"unapproved.app"},new AbortController().signal,async()=>true,io),/允许列表/);
    useComputerSettings.setState({enabled:false});
    await assert.rejects(runComputerAssistant(goal,new AbortController().signal,async()=>true,io),/启用/);
  } finally {useComputerSettings.setState(settings);useAppStore.setState({remoteModels:state.remoteModels});}
});
