/* Client half: a session-level memory on/off switch in the composer tool row. */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory-library',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/dsh-memory-api';

    function token() {
      return (typeof window !== 'undefined' && window.__DSH_MEMORY_TOKEN__) || '';
    }

    async function request(path, options) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        cache: 'no-store',
        headers: {
          ...((options && options.headers) || {}),
          'x-dsh-memory-token': token(),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    function MemoryToggle(props) {
      const sessionId = props && props.sessionId;
      const zh = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '');
      const label = zh ? '记忆' : 'Memory';
      const [phase, setPhase] = React.useState('loading');
      const [enabled, setEnabled] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        if (!sessionId) return undefined;
        let cancelled = false;
        const load = async () => {
          try {
            const data = await request(`/session?id=${encodeURIComponent(sessionId)}`);
            if (cancelled) return;
            setEnabled(Boolean(data.enabled));
            setPhase('ready');
            setError('');
          } catch (failure) {
            if (cancelled) return;
            setPhase('error');
            setError(String((failure && failure.message) || failure));
          }
        };
        load();
        const timer = setInterval(load, 5000);
        const onFocus = () => load();
        window.addEventListener('focus', onFocus);
        return () => {
          cancelled = true;
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, [sessionId]);

      const toggle = async () => {
        if (!sessionId || busy || phase === 'loading') return;
        setBusy(true);
        try {
          const data = await request('/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: !enabled }),
          });
          setEnabled(Boolean(data.enabled));
          setPhase('ready');
          setError('');
        } catch (failure) {
          setPhase('error');
          setError(String((failure && failure.message) || failure));
        } finally {
          setBusy(false);
        }
      };

      if (!sessionId) return null;

      const active = enabled;
      const text = phase === 'loading'
        ? `${label} …`
        : phase === 'error'
          ? `${label} !`
          : `${label} ${active ? (zh ? '开' : 'ON') : (zh ? '关' : 'OFF')}`;
      const title = phase === 'error'
        ? `记忆开关不可用：${error}`
        : active
          ? (zh ? '本对话记忆已开启，点击关闭' : 'Memory is on for this conversation. Click to turn off.')
          : (zh ? '本对话记忆已关闭，点击开启' : 'Memory is off for this conversation. Click to turn on.');

      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': active,
          'aria-label': title,
          title,
          disabled: busy || phase === 'loading',
          onClick: toggle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 26,
            padding: '0 9px',
            borderRadius: 999,
            border: `1px solid ${active
              ? 'var(--dsw-alias-brand-primary)'
              : hover
                ? 'var(--dsw-alias-border-l2)'
                : 'var(--dsw-alias-border-l1)'}`,
            background: 'var(--dsw-alias-bg-layer-2)',
            color: phase === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1,
            cursor: busy || phase === 'loading' ? 'progress' : 'pointer',
            opacity: busy ? 0.65 : 1,
            userSelect: 'none',
            whiteSpace: 'nowrap',
            transition: 'border-color 120ms ease, opacity 120ms ease',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: active
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-state-idle-primary)',
          },
        }),
        h('span', null, text),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'memory-toggle',
              order: 40,
            },
            MemoryToggle,
          ),
        );
      },
    };
  },
});
