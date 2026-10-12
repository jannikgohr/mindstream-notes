"""Real WebView2 editor persistence during a supervised worker handoff.

Attach Microsoft Edge WebDriver only to this fixture's isolated browser. Both
main and popout editors have automatic saving disabled; their text must reach
SQLite before the source exits. The coordinator and workers close through IPC.
"""
import argparse,base64,importlib.util,json,os,socket,sqlite3,subprocess,urllib.request,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('h', Path(__file__).with_name('supervised-handoff-check.py'));h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
def freeport():
 with socket.socket() as s: s.bind(('127.0.0.1',0));return s.getsockname()[1]
debug,port=freeport(),freeport()
class Fixture(h.Fixture):
 def launch(self):
  (self.root/'profiles/source/content-settings.json').write_text(json.dumps({'version':1,'revision':0,'values':{'editor.autoSave':False}}))
  self.env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']=f'--remote-debugging-port={debug}'
  super().launch()
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--exe',type=Path,required=True);parser.add_argument('--check-progress',action='store_true');args=parser.parse_args()
assert os.name=='nt', 'this UI fixture uses WebView2 and Microsoft Edge WebDriver'
f=Fixture(args.output,args.exe)
log=(f.output/'webdriver.log').open('w');driver=subprocess.Popen(['msedgedriver',f'--port={port}'],stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
def request(path,payload=None):
 req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=None if payload is None else json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req) as r:return json.load(r)['value']
 except urllib.error.HTTPError as e:raise RuntimeError(e.read().decode())
try:
 h.wait(lambda:request('/status'))
 session=request('/session',{'capabilities':{'alwaysMatch':{'browserName':'MicrosoftEdge','ms:edgeOptions':{'debuggerAddress':f'127.0.0.1:{debug}'}}}})
 print('Attached session',session['sessionId'],flush=True)
 sid=session['sessionId'];base='/session/'+sid
 def execute(script, *args):
  return request(base+'/execute/sync', {'script':script,'args':list(args)})
 marker_main='Handoff main '+h.uid();marker_popout='Handoff popout '+h.uid()
 insert="const el=document.querySelector('.ProseMirror'); if(!el)throw new Error('editor not ready');el.focus();const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.execCommand('insertText',false,arguments[0]);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:arguments[0]}));return el.innerText;"
 h.wait(lambda:execute('return !!document.querySelector(".ProseMirror")'))
 assert marker_main in execute(insert,marker_main)
 geometry=next(window for window in f.windows('source') if window['label']=='main')
 popout={**geometry,'label':'note_seed_sprint','note_id':'seed_sprint','x':180,'y':130,'visible':True}
 restore=h.uid();assert 'Ok' in f.private('source','restoreWindows',restore,vault={'id':'source','directory':f.identity('source')['directory'],'windows':[geometry,popout]})
 h.wait(lambda:f.private('source','restoreStatus',operation_id=restore)['Ok']['state']=='ready')
 handles=h.wait(lambda: v if len(v:=request(base+'/window/handles'))>1 else None)
 for handle in handles:
  request(base+'/window',{'handle':handle})
  if execute('return location.search').find('seed_sprint')>=0:break
 else:raise AssertionError('restored note popout was not found')
 h.wait(lambda:execute('return !!document.querySelector(".ProseMirror")'))
 assert marker_popout in execute(insert,marker_popout)
 (f.output/'popout-before-handoff.png').write_bytes(base64.b64decode(request(base+'/screenshot')))
 time.sleep(0.3)
 dbfile=f.root/'profiles/source/mindstream.db'
 def bodies():
  with sqlite3.connect(dbfile) as db:return dict(db.execute("select id,body from notes where id in ('seed_welcome','seed_sprint')"))
 before=bodies();assert marker_main not in before['seed_welcome'];assert marker_popout not in before['seed_sprint']
 if args.check_progress:
  assert 'Ok' in f.private('source','testHoldJob',seconds=15)
  execute("void window.__TAURI_INTERNALS__.invoke('open_profile_window',{id:'target',inThisWindow:true}).catch(error=>{window.__handoffError=String(error)});return true;")
  def progress():
   return execute("const region=document.querySelector('[data-toast-region]');const card=region?.querySelector('[role=status]');if(!card)return null;const bounds=region.getBoundingClientRect();return {text:card.innerText,buttons:card.querySelectorAll('button').length,right:innerWidth-bounds.right,bottom:innerHeight-bounds.bottom,dialogs:document.querySelectorAll('dialog[open]').length};")
  toast=h.wait(progress,12)
  assert toast['text']=='Preparing to close vault…',toast
  assert toast['buttons']==0 and toast['dialogs']==0,toast
  assert abs(toast['right']-16)<1 and abs(toast['bottom']-16)<1,toast
  (f.output/'progress-toast.json').write_text(json.dumps(toast))
  (f.output/'progress-toast.png').write_bytes(base64.b64decode(request(base+'/screenshot')))
  h.wait(lambda:f.journal().get('phase')=='completed',150)
  assert not h.owned(f.root/'profiles/source/.vault.lock')
 else:
  f.handoff()
 after=bodies();assert marker_main in after['seed_welcome'];assert marker_popout in after['seed_sprint']
 assert f.journal()['phase']=='completed'
 (f.output/'saved-editors.json').write_text(json.dumps({'main':marker_main,'popout':marker_popout,'sourceClosed':not h.owned(f.root/'profiles/source/.vault.lock')}))
 print('Handoff saved unsaved main and popout edits with automatic saving disabled',flush=True)
except Exception as e:print(type(e).__name__,e,flush=True);raise
finally:
 try:
  f.cleanup()
 finally:
  driver.terminate();driver.wait(timeout=10);log.close()
