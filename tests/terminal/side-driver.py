"""Offline real-process side chat acceptance; screenshots are reconstructed PTY frames."""
from __future__ import annotations
import codecs, errno, fcntl, json, os, pathlib, pty, select, signal, struct, subprocess, tempfile, termios, time
import pyte
from frame_capture import save_frame
root = pathlib.Path(__file__).resolve().parents[2]
artifacts = pathlib.Path('/tmp/vimex-side-e2e')
screen = pyte.Screen(150, 36)
stream = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH',36,150,0,0))
with tempfile.TemporaryDirectory(prefix='vimex-side-') as temporary:
    trace = pathlib.Path(temporary)/'trace.jsonl'
    config = pathlib.Path(temporary)/'config.json'
    config.write_text(json.dumps({'codexExecutable':str(root/'tests/terminal/fixtures/side-app-server.ts')}))
    process = subprocess.Popen(['bun','run','apps/tui/src/main.tsx','--config',str(config),'--cwd',temporary], cwd=root, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        env={**os.environ,'TERM':'xterm-256color','COLORTERM':'truecolor','NO_COLOR':'','HERDR_ENV':'0','XDG_STATE_HOME':temporary,'XDG_CONFIG_HOME':temporary,'VIMEX_TEST_TRACE':str(trace)})
    os.close(slave)
    def pump(seconds=.2):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            if select.select([master],[],[],min(.03,max(0,deadline-time.monotonic())))[0]:
                try:data=os.read(master,65536)
                except OSError as error:
                    if error.errno==errno.EIO:return
                    raise
                if not data:return
                stream.feed(decoder.decode(data))
    def send(value):os.write(master,value);pump()
    def view():return '\n'.join(screen.display)
    def wait(value):
        deadline=time.monotonic()+12
        while value not in view():
            if time.monotonic()>deadline:raise AssertionError('Missing '+value)
            pump()
    def calls(method):return [row for row in (json.loads(line) for line in trace.read_text().splitlines()) if row.get('method')==method]
    def capture(name):pump();save_frame(screen,artifacts,name)
    def command(text):send(b':');send(text.encode());send(b'\r')
    def assert_right_pane(title):
        rows=[line for line in screen.display if 'MAIN /' in line and ('SIDE / '+title) in line]
        assert rows and rows[0].index('SIDE /')>screen.columns//2, 'Side is not rendered in a right-hand pane'
        assert 'SIDE · focused' in view(), 'New side was not focused'
    checks=[]
    try:
        wait('fixture-model')
        command('restart')
        deadline=time.monotonic()+10
        while len(calls('initialize'))<2 or not calls('thread/resume'):
            pump(.1)
            if time.monotonic()>deadline:raise AssertionError('Restart did not reconnect and resume')
        wait('connected')
        checks.append('restart-reconnects-and-resumes')
        send(b'i');send(b'Keep implementing');send(b'\r');wait('Parent progress')
        send(b'/side');send(b'\r');wait('Side chat 1')
        assert len(calls('thread/fork'))==1
        assert_right_pane('Side chat 1')
        assert len(calls('turn/start'))==1, 'Bare /side unexpectedly submitted a child turn'
        capture('00-bare-slash-side');checks.append('bare-slash-creates-right-pane')
        send(b'i');send(b'How is progress?');send(b'\r');wait('independent')
        assert calls('turn/start')[-1]['params']['threadId']=='side-child-1'
        before=view();pump(.8);assert 'Parent progress' in view() and view()!=before
        capture('01-side-parent-streaming');checks.append('slash-side-parent-keeps-streaming')
        send(b'\x1b');command('side maximize');capture('02-side-maximized')
        assert 'Main agent is working.' not in view()
        command('side reset');wait('Parent progress');checks.append('maximize-and-restore')
        send(b'\x17h');wait('MAIN · focused');capture('03-parent-focused')
        send(b'\x17l');wait('SIDE · focused');checks.append('window-focus-bindings')
        command('side close');pump()
        assert 'Side chat 1' not in view()
        assert not calls('thread/archive')
        command('side');wait('Side chat 1');assert len(calls('thread/fork'))==1
        capture('04-side-reopened');checks.append('close-reopen-same-worker')
        command('side quit');pump(.5)
        assert calls('thread/archive')[-1]['params']['threadId']=='side-child-1'
        assert calls('turn/interrupt')[-1]['params']['threadId']=='side-child-1'
        starts_before=len(calls('turn/start'))
        command('side');wait('Side chat 2');assert len(calls('thread/fork'))==2
        assert_right_pane('Side chat 2')
        assert len(calls('turn/start'))==starts_before, 'Bare :side unexpectedly submitted a child turn'
        capture('05-new-side-after-quit');checks.append('quit-stops-and-next-side-is-new')
        checks.append('bare-colon-creates-right-pane')
        screen.resize(lines=36,columns=90)
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',36,90,0,0));os.killpg(process.pid,signal.SIGWINCH);pump(.5)
        capture('06-stacked-narrow');assert 'MAIN /' in view() and 'SIDE /' in view()
        checks.append('narrow-stacked-panes')
        command('quit');process.wait(timeout=10)
        assert process.returncode==0
        artifacts.mkdir(exist_ok=True);(artifacts/'trace.jsonl').write_text(trace.read_text())
        print(json.dumps({'passed':True,'checks':checks,'artifacts':str(artifacts)}))
    except BaseException:
        capture('99-failure');raise
    finally:
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        os.close(master)
