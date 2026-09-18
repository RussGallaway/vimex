// Run: bun scripts/benchmark-transcript-scroll.tsx
// Diagnostic actual-renderer benchmark; no machine-dependent timing gate.
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import type { ScrollBoxRenderable } from '@opentui/core'
import { ToolCall } from '../packages/ui-opentui-react/src/transcript/ToolCall'
import { measureRenderedTranscript, topVisiblePoint } from '../packages/ui-opentui-react/src/transcript/rendered-layout'
import { initialTranscript, syncTranscriptItem } from '@vimex/transcript'
import { itemId, turnId } from '@vimex/conversation'
const item = {id:itemId('large'),turnId:turnId('t'),kind:'command' as const,title:'Large output',detail:Array.from({length:1500},(_,i)=>`${i}: ${'result '.repeat(12)}`).join('\n'),status:'complete' as const}
const state=syncTranscriptItem(initialTranscript(),item)
const h=await testRender(<scrollbox id="scroll" width="100%" height="100%"><box id="transcript-item:large"><ToolCall item={item} folded={false}/></box></scrollbox>,{width:100,height:30})
try {
 await act(async()=>{await h.flush();await h.renderOnce()})
 const scroll=h.renderer.root.findDescendantById('scroll') as ScrollBoxRenderable
 measureRenderedTranscript(h.renderer,scroll,state)
 const measurements:number[]=[], anchors:number[]=[],frames:number[]=[]
 for(let i=0;i<12;i++){
   scroll.scrollBy(15,'step')
   let start=performance.now();await h.renderOnce();frames.push(performance.now()-start)
   start=performance.now();const layout=measureRenderedTranscript(h.renderer,scroll,state)!;measurements.push(performance.now()-start)
   start=performance.now();topVisiblePoint(layout,scroll);anchors.push(performance.now()-start)
 }
 const avg=(xs:number[])=>xs.reduce((a,b)=>a+b)/xs.length
 console.log(JSON.stringify({chars:item.detail.length,measureMs:avg(measurements),anchorMs:avg(anchors),frameMs:avg(frames)}))
}finally{await act(async()=>h.renderer.destroy())}
