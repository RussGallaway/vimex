"""Offline real-process TUI visual regression probe; optional requirements-live.txt."""
from __future__ import annotations
import codecs, errno, fcntl, json, os, pathlib, pty, select, signal, struct, subprocess, tempfile, termios, time
import pyte
from frame_capture import save_frame

root = pathlib.Path(__file__).resolve().parents[2]
theme = os.environ.get('VIMEX_TEST_THEME', '')
if theme not in ('', 'ember-tide', 'nord', 'kanagawa', 'gruvbox-material', 'tokyo-night', 'catppuccin-mocha'):
    raise ValueError('Unsupported VIMEX_TEST_THEME')
artifacts = pathlib.Path('/tmp/vimex-visual-e2e' + ('-' + theme if theme else ''))
screen = pyte.Screen(100, 30)
stream = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
with tempfile.TemporaryDirectory(prefix='vimex-visual-') as temporary:
    binary = os.environ.get('VIMEX_TEST_BINARY')
    command = [str(pathlib.Path(binary).resolve()), '--demo'] if binary else ['bun', 'run', 'apps/tui/src/main.tsx', '--demo']
    process = subprocess.Popen(command, cwd=temporary if binary else root, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        env={**os.environ, 'TERM':'xterm-256color', 'COLORTERM':'truecolor', 'NO_COLOR':'', 'HERDR_ENV':'0', 'XDG_STATE_HOME':temporary, 'XDG_CONFIG_HOME':temporary})
    os.close(slave)
    def pump(seconds=0.2):
        deadline = time.monotonic()+seconds
        while time.monotonic()<deadline:
            if select.select([master], [], [], min(0.03, max(0, deadline-time.monotonic())))[0]:
                try: data=os.read(master,65536)
                except OSError as error:
                    if error.errno==errno.EIO: return
                    raise
                if not data:return
                stream.feed(decoder.decode(data))
    def send(value):
        os.write(master,value);pump()
    def wait(value):
        deadline=time.monotonic()+10
        while value not in '\n'.join(screen.display):
            if time.monotonic()>deadline:raise AssertionError('Missing '+value)
            pump()
    def capture(stage):
        pump();save_frame(screen,artifacts,stage)
    checks=[]
    try:
        wait('NORMAL')
        if theme:
            send(b':theme ' + theme.encode() + b'\r');wait('NORMAL')
        capture('01-demo')
        send(b'\x1b[B');send(b'i');wait('INSERT')
        send(b'Draft stays separate from status');capture('02-draft')
        send(b'\x1b');wait('NORMAL')
        send('#|\\é'.encode());send(b'\x1b[200~PASTE_MUST_NOT_INSERT\x1b[201~');capture('02-normal-mode-isolation')
        visible='\n'.join(screen.display)
        assert any(line.strip(' │') == 'Draft stays separate from status' for line in screen.display) and 'PASTE_MUST_NOT_INSERT' not in visible, 'Normal mode modified the draft'
        checks.append('normal-mode-input-isolation')
        send(b'\x1b[A');send(b'gg');capture('03-normal-transcript-cursor')
        assert not screen.cursor.hidden, 'Normal transcript cursor is hidden'
        old_cursor=(screen.cursor.x,screen.cursor.y)
        send(b'l')
        assert (screen.cursor.x,screen.cursor.y)==(old_cursor[0]+1,old_cursor[1]), 'Transcript cursor did not move one character'
        checks.append('precise-transcript-cursor')
        before_flash=(screen.cursor.x,screen.cursor.y)
        send(b's');wait('Jump /');send(b'Vimex');wait('matches');capture('03-flash-labels')
        send(b'a');pump();assert 'Jump /' not in '\n'.join(screen.display), 'Flash did not jump'
        send(b'\x0f');pump();assert (screen.cursor.x,screen.cursor.y)==before_flash, 'Jump-back did not restore transcript cursor'
        checks.append('flash-label-and-jump-back')
        send(b'Vj');wait('VISUAL');capture('03-selection')
        assert not screen.cursor.hidden, 'Visual transcript head cursor is hidden'
        send(b'\x1b');wait('NORMAL')
        screen.resize(lines=18,columns=48)
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',18,48,0,0));os.killpg(process.pid,signal.SIGWINCH)
        pump(0.5);capture('04-narrow')
        send(b' s');wait('Sessions');capture('05-sessions')
        send(b'NO_SUCH_VIMEX_SESSION_729');pump(0.5);capture('06-filtered-sessions')
        wait('No matching sessions');checks.append('session-filter-reactive')
        send(b'\x1b');send(b'\x1b');wait('NORMAL')
        send(b':');wait('COMMAND');capture('07-command-bar');send(b'help');send(b'\r');wait('Vimex keys');capture('07-help-centered');send(b'\x1b');wait('NORMAL')
        screen.resize(lines=30,columns=100)
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0));os.killpg(process.pid,signal.SIGWINCH);pump(0.3)
        send(b':');send(b'mod');send(b'\t');wait(':model ')
        send(b'de');send(b'\t');wait(':model demo ')
        send(b'med');send(b'\t');wait(':model demo medium ');capture('07-model-effort-completion')
        send(b'\r');wait('NORMAL')
        assert any('Codex' in line and 'medium' in line for line in screen.display), 'Combined model/effort command did not update metadata'
        checks.append('model-effort-completion')
        send(b'\x1b[B');send(b'gg0vG$d');capture('08-visual-delete')
        assert 'Draft stays separate from status' not in '\n'.join(screen.display), 'Visual delete left the draft behind'
        send(b'i');wait('INSERT');send(b'/');wait('Commands');capture('08-slash-command-drawer')
        send(b'help');send(b'\r');wait('Vimex keys');capture('08-slash-help');send(b'\x1b');wait('NORMAL')
        checks.append('visual-delete-and-slash-commands')
        send(b'\x1b[B');send(b'i');wait('INSERT');send(b'Draft stays separate from status');send(b'\rNEXT_DRAFT_AFTER_SEND');wait('Responding')
        assert 'NEXT_DRAFT_AFTER_SEND' in '\n'.join(screen.display[-9:]), 'Next draft missing after submit'
        assert 'statusNEXT_DRAFT_AFTER_SEND' not in '\n'.join(screen.display), 'Submitted native text was resurrected'
        checks.append('submit-clears-before-next-keystroke')
        capture('08-working-heartbeat-a');pump(0.25);capture('09-working-heartbeat-b')
        panel_rows=[row for row in range(screen.lines) if screen.buffer[row][0].data == '│']
        send(b'\x1b[200~'+('\n'.join('Multiline '+str(i) for i in range(20))).encode()+b'\x1b[201~')
        capture('10-fixed-height-multiline')
        assert panel_rows and [row for row in range(screen.lines) if screen.buffer[row][0].data == '│']==panel_rows, 'Composer grew with newlines'
        checks.append('fixed-composer-height')
        send(b'\x1b');wait('NORMAL');send(b':');wait('COMMAND');send(b'q');send(b'\r');process.wait(timeout=10)
        assert process.returncode==0
        checks.append('normal-exit')
        print(json.dumps({'passed':True,'checks':checks,'artifacts':str(artifacts)}))
    except BaseException:
        capture('99-failure');raise
    finally:
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        os.close(master)
