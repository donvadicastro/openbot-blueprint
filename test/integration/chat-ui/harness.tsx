import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectChatWork } from '/src/components/channels/project-chat-work';
let answered = false;
let approved = false;
let recoveryRequested = false;
let statusCalls = 0;
const work = { id:'work', request:'Verify the checkout', conversationId:'channel', runs:[{id:'run',state:'Running',canRecover:true,currentPhase:'verify',attempts:[{retryNumber:2,state:'Running',feedbackClarification:true,rejections:[{code:'invalid_action_result'}]}],qaProgress:[{scenarioId:'s1'}], decisions:[{id:'d1',state:'Pending',question:'Continue?',kind:'choice',choices:['verify-only'],deliveryState:null}]}] };
const event = {type:'STATE_SNAPSHOT',snapshot:{projectId:'project',conversationId:'channel',workItemId:'work',runId:'run',viewId:'qa-view',records:[],qaProgress:[{scenarioId:'s1',status:'passed',phase:'verify',occurrenceId:'occ',attempt:1,total:1,stale:false,updatedAt:'2026-01-01',steps:['Open fixture'],expected:'Fixture passes',observed:'Fixture passes',reason:null,evidenceId:'evidence-1',reportVerdict:'passed'}]}};
const pendingEvent = {...event,snapshot:{...event.snapshot,qaProgress:event.snapshot.qaProgress.map(item=>({...item,reportVerdict:null}))}};
const pmEvent = {type:'STATE_SNAPSHOT',snapshot:{projectId:'project',conversationId:'channel',workItemId:'work',runId:'run',viewId:'pm-view',records:[{type:'change-brief',revisionId:'brief-1',stale:false,fields:{scope:'Deliver a useful feature',scenarios:[{id:'scenario-one',expected:'It works'}]}}],qaProgress:[]}};
const releaseEvent = {type:'STATE_SNAPSHOT',snapshot:{projectId:'project',conversationId:'channel',workItemId:'work',runId:'run',viewId:'release-view',records:[{type:'candidate',revisionId:'candidate-1',stale:false,fields:{revision:'candidate-sha'}},{type:'qa-evidence',revisionId:'qa-1',stale:false,fields:{verdict:'passed'}},{type:'release-target',revisionId:'target-1',stale:false,fields:{url:'staging-fixture'}}],qaProgress:[]}};
const finalReleaseEvent = {...releaseEvent,snapshot:{...releaseEvent.snapshot,records:[...releaseEvent.snapshot.records,{type:'deployment-evidence',revisionId:'deploy-1',stale:false,fields:{target:'staging-fixture',receipt:'verified-receipt',verified:true}}]}};
window.fetch = async (input, init) => {
  const path=String(input);
  if (path.endsWith('/blueprint')) return Response.json({agents:[{id:'qa-bot',name:'QA Specialist'},{id:'pm-bot',name:'Product Manager'},{id:'release-bot',name:'Release Engineer'}],business:{roles:[{id:'qa',agentId:'qa-bot'},{id:'pm',agentId:'pm-bot'},{id:'release',agentId:'release-bot'}],views:[{id:'qa-view',role:'qa',recordTypes:['qa-evidence']},{id:'pm-view',role:'pm',recordTypes:['change-brief']},{id:'release-view',role:'release',recordTypes:['release-target','qa-evidence']} ]}});
  if (path.endsWith('/work-items')) return Response.json({workItems:[{id:'work',request:'Verify the checkout',conversationId:'channel'}]});
  if (path.endsWith('/work-items/work')) return Response.json({workItem:{...work,runs:work.runs.map(r=>({...r,...(approved?{state:'Completed',currentPhase:'released',canRecover:false}:{}),decisions:answered?(approved?[]:[{id:'approval',state:'Pending',question:'Approve candidate-sha to staging-fixture?',kind:'choice',choices:['approve','reject'],approval:true,canAnswer:true}]):r.decisions}))}});
  if (path.endsWith('/events') && path.includes('/pm-view/')) return new Response(`data: ${JSON.stringify(pmEvent)}\n\n`,{headers:{'content-type':'text/event-stream'}});
  if (path.endsWith('/events') && path.includes('/release-view/')) return new Response(`data: ${JSON.stringify(approved ? finalReleaseEvent : releaseEvent)}\n\n`,{headers:{'content-type':'text/event-stream'}});
  if (path.endsWith('/events')) {
    let timer: ReturnType<typeof setTimeout>;
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(pendingEvent)}\n\n`));
      timer=setTimeout(()=>{controller.enqueue(encoder.encode(`data: ${JSON.stringify({type:'STATE_DELTA',delta:[{op:'replace',path:'',value:event.snapshot}]})}\n\n`)); controller.close();},500);
    },cancel(){clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}});
  }
  if (path.endsWith('/status')) return Response.json({state: ++statusCalls === 1 ? 'running' : 'uncertain'});
  if (path.endsWith('/reconcile') && init?.method==='POST') { recoveryRequested=true; return Response.json({accepted:true}); }
  if (path.endsWith('/decisions/d1') && init?.method==='POST') { const body=JSON.parse(String(init.body)); answered=body.value==='verify-only'; return Response.json({ok:true}); }
  if (path.endsWith('/decisions/approval') && init?.method==='POST') { const body=JSON.parse(String(init.body)); approved=body.value==='approve'; return Response.json({ok:true}); }
  return new Response('Not found',{status:404});
};
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ProjectChatWork projectId="project" conversationId="channel" /></QueryClientProvider>);
const deadline=Date.now()+10000;
let verifiedQa=false;
let sawAwaiting=false;
let sawReleaseEvidence=false;
let sawRecovery=false;
let sawHeld=false;
let sawRunningWithoutRecovery=false;
let sawRejection=false;
let sawFeedback=false;
const interval=setInterval(()=>{
  const panel=[...document.querySelectorAll('summary')].find(el=>el.textContent?.includes('Project work in this conversation')) as HTMLElement | undefined;
  if(panel && !panel.parentElement?.hasAttribute('open')) panel.click();
  const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('Verify the checkout')) as HTMLButtonElement | undefined;
  if(button && button.getAttribute('aria-pressed') !== 'true') button.click();
  const scenario=[...document.querySelectorAll('summary')].find(el=>el.textContent?.includes('s1')) as HTMLElement | undefined;
  if(scenario && !scenario.parentElement?.hasAttribute('open')) scenario.click();
  const recovery=[...document.querySelectorAll('button')].find(b=>b.textContent==='Check and recover interrupted work') as HTMLButtonElement | undefined;
  if(statusCalls === 1 && !recovery) sawRunningWithoutRecovery=true;
  if(recovery && !recoveryRequested) recovery.click();
  const decision=[...document.querySelectorAll('button')].find(b=>b.textContent==='verify-only') as HTMLButtonElement | undefined;
  if(decision && !answered) decision.click();
  const text=document.body.textContent ?? '';
  if(text.includes('Awaiting report')) sawAwaiting=true;
  if(text.includes('The workflow is waiting for its previous action to be checked.')) sawHeld=true;
  if(text.includes('Recovery requested.')) sawRecovery=true;
  if(text.includes('specialist result was rejected')) sawRejection=true;
  if(text.includes('Waiting for feedback clarification.')) sawFeedback=true;
  if(answered && text.includes('QA Specialist') && text.includes('Passed · 1 of 1 scenarios passed') && text.includes('Open fixture') && text.includes('Evidence: evidence-1')) {
    verifiedQa=true;
    const selector=document.querySelector('select') as HTMLSelectElement | null;
    if(selector && selector.value!=='pm-view') { selector.value='pm-view'; selector.dispatchEvent(new Event('change',{bubbles:true})); }
  }
  const brief=[...document.querySelectorAll('summary')].find(el=>el.textContent?.includes('change-brief')) as HTMLElement | undefined;
  if(brief && !brief.parentElement?.hasAttribute('open')) brief.click();
  const summaries=[...document.querySelectorAll('summary')].map(item=>item.textContent?.trim());
  if(text.includes('Release evidence') && summaries.includes('candidate') && summaries.includes('qa-evidence') && summaries.includes('release-target') && text.includes('candidate-sha') && text.includes('staging-fixture')) sawReleaseEvidence=true;
  const approve=[...document.querySelectorAll('button')].find(b=>b.textContent==='approve') as HTMLButtonElement | undefined;
  if(approve && sawReleaseEvidence && sawRecovery && !approved) approve.click();
  if(sawAwaiting && verifiedQa && sawReleaseEvidence && approved && recoveryRequested && sawRecovery && sawHeld && sawRunningWithoutRecovery && sawRejection && sawFeedback && !text.includes('specialist result was rejected') && !text.includes('Waiting for feedback clarification.') && text.includes('Attempt 2') && text.includes('Verified release to staging-fixture.') && text.includes('Product Manager') && text.includes('Deliver a useful feature') && text.includes('scenario-one') && text.includes('It works')) {
    document.body.dataset.testResult='PASS'; clearInterval(interval);
  } else if(Date.now()>deadline) { document.body.dataset.testResult='FAIL'; clearInterval(interval); }
},100);
