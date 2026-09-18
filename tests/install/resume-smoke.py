"""Real CLI resume routing through PTY/JSONL; never starts a live Codex process."""
import errno, fcntl, json, os, pathlib, pty, select, signal, struct, subprocess, sys, tempfile, termios, time
root=pathlib.Path(__file__).resolve().parents[2]
binary=str(pathlib.Path(sys.argv[1]).resolve()) if len(sys.argv)>1 else None
checks=[]
for arguments in [['resume','side-main'],['resume','--last'],['resume']]:
    with tempfile.TemporaryDirectory(prefix='vimex-resume-') as temporary:
        trace=pathlib.Path(temporary)/'trace.jsonl'
        config=pathlib.Path(temporary)/'config.json'
        config.write_text(json.dumps({'codexExecutable':str(root/'tests/terminal/fixtures/side-app-server.ts')}))
        master,slave=pty.openpty()
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',30,110,0,0))
        command=[binary] if binary else ['bun','run',str(root/'apps/cli/src/main.ts')]
        child=subprocess.Popen([*command,*arguments,'--config',str(config),'--cwd',temporary],cwd=temporary,stdin=slave,stdout=slave,stderr=slave,start_new_session=True,
            env={**os.environ,'TERM':'xterm-256color','HERDR_ENV':'0','XDG_CONFIG_HOME':temporary,'XDG_STATE_HOME':temporary,'VIMEX_TEST_TRACE':str(trace)})
        os.close(slave)
        output=bytearray()
        def pump(seconds=.1):
            end=time.monotonic()+seconds
            while time.monotonic()<end:
                if select.select([master],[],[],min(.03,max(0,end-time.monotonic())))[0]:
                    try:data=os.read(master,65536)
                    except OSError as error:
                        if error.errno==errno.EIO:return
                        raise
                    if not data:return
                    output.extend(data)
        try:
            deadline=time.monotonic()+12
            while True:
                calls=[json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
                if any(call.get('method')=='thread/resume' for call in calls) and b'NORMAL' in output:break
                if child.poll() is not None or time.monotonic()>deadline:raise AssertionError('Resume did not initialize for '+repr(arguments)+': '+repr(bytes(output[-1600:])))
                pump()
            pump(.3)
            os.write(master,b'\x1b');pump(.2)
            os.write(master,b':quit\r')
            while child.poll() is None and time.monotonic()<deadline:pump()
            assert child.poll()==0, 'Resume CLI did not quit cleanly'
            calls=[json.loads(line) for line in trace.read_text().splitlines()]
            resumed=[call for call in calls if call.get('method')=='thread/resume']
            assert len(resumed)==1 and resumed[0]['params']['threadId']=='side-main', 'Wrong resume target'
            assert not any(call.get('method') in ('thread/start','turn/start','turn/steer','thread/fork') for call in calls), 'Resume created a conversation or sent a message'
            checks.append(' '.join(arguments))
        finally:
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=2)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            os.close(master)
print(json.dumps({'passed':True,'binary':binary,'checks':checks}))
