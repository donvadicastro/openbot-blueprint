import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectWorkflowRecovery } from '/src/components/channels/business-projects';
let calls=0, requested=false;
window.fetch=async (input,init)=>{
  const path=String(input);
  if(path.endsWith('/status')) return Response.json({state: ++calls===1?'running':'uncertain',reasonCode:'release-target-unavailable'});
  if(path.endsWith('/reconcile') && init?.method==='POST'){requested=true; return Response.json({accepted:true});}
  return new Response('Not found',{status:404});
};
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ProjectWorkflowRecovery projectId="project" workItemId="work" runId="run" /></QueryClientProvider>);
let sawRunning=false; const deadline=Date.now()+10000;
const interval=setInterval(()=>{
  const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Check and recover interrupted work') as HTMLButtonElement | undefined;
  if(calls===1 && !button) sawRunning=true;
  if(button && !requested) button.click();
  if(sawRunning && requested && document.body.textContent?.includes('Recovery requested.') && document.body.textContent?.includes('The staging target is not configured.')) {document.body.dataset.testResult='PASS';clearInterval(interval);}
  else if(Date.now()>deadline){document.body.dataset.testResult='FAIL';clearInterval(interval);}
},100);
