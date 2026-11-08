// Shared, accessible UI building blocks (Persian labels, RTL aware).
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { ICONS } from './icons.generated.js';
import { formatNumber, parseNumber } from '../core/digits.js';

export function Icon({ name, size, class: cls, label }) {
  const inner = ICONS[name] || '';
  return (
    <svg
      class={cls}
      width={size || 20}
      height={size || 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

export function Button({ icon, children, variant = '', size = '', block, busy, class: cls = '', ...rest }) {
  return (
    <button type="button" class={`btn ${variant ? `btn-${variant}` : ''} ${size ? `btn-${size}` : ''} ${block ? 'btn-block' : ''} ${cls}`} aria-busy={busy ? 'true' : undefined} {...rest}>
      {busy ? <Icon name="loader-circle" class="spin" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/** Icon-only button: label is required (screen readers + tooltip). */
export function IconButton({ icon, label, pressed, small, tipBelow, class: cls = '', ...rest }) {
  return (
    <button
      type="button"
      class={`icon-btn ${small ? 'sm' : ''} ${tipBelow ? 'tip-below' : ''} ${cls}`}
      aria-label={label}
      data-tip={label}
      aria-pressed={pressed == null ? undefined : String(!!pressed)}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Field({ label, children, hint, error, id }) {
  return (
    <div class="field">
      {label ? <label class="field-label" for={id}>{label}</label> : null}
      {children}
      {error ? <div class="field-error" role="alert">{error}</div> : hint ? <div class="hint">{hint}</div> : null}
    </div>
  );
}

/**
 * Numeric text input that accepts Persian/Latin digits; commits valid values on
 * blur/Enter and supports arrow-key stepping. Invalid input is shown, never applied.
 */
export function NumberInput({ label, value, onChange, min = -Infinity, max = Infinity, step = 1, unit, integer = false, maxFraction = 2, hint, disabled, allowEmpty = false, placeholder, ariaLabel }) {
  const id = useId();
  const [text, setText] = useState(value == null ? '' : formatNumber(value, { maxFraction }));
  const [error, setError] = useState('');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) { setText(value == null ? '' : formatNumber(value, { maxFraction })); setError(''); }
  }, [value, maxFraction]);
  const validate = (t) => {
    if (allowEmpty && String(t).trim() === '') return { ok: true, v: null };
    const v = parseNumber(t);
    if (!Number.isFinite(v)) return { ok: false, msg: 'عدد معتبر وارد کنید.' };
    if (integer && !Number.isInteger(v)) return { ok: false, msg: 'عدد صحیح وارد کنید.' };
    if (v < min) return { ok: false, msg: `کمترین مقدار ${formatNumber(min)} است.` };
    if (v > max) return { ok: false, msg: `بیشترین مقدار ${formatNumber(max)} است.` };
    return { ok: true, v };
  };
  const commit = (t) => {
    const r = validate(t);
    if (!r.ok) { setError(r.msg); return; }
    setError('');
    if (r.v !== value) onChange(r.v);
    setText(r.v == null ? '' : formatNumber(r.v, { maxFraction }));
  };
  const nudge = (dir, big) => {
    const base = Number.isFinite(value) ? value : (Number.isFinite(min) ? min : 0);
    let v = base + dir * step * (big ? 10 : 1);
    v = Math.min(max, Math.max(min, Math.round(v * 1000) / 1000));
    onChange(v);
    setText(formatNumber(v, { maxFraction }));
  };
  return (
    <Field label={label} id={id} hint={hint} error={error}>
      <div class="input-wrap">
        <input
          id={id}
          class="input"
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          autoComplete="off"
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={label ? undefined : ariaLabel}
          aria-invalid={error ? 'true' : 'false'}
          onFocus={() => { focused.current = true; }}
          onBlur={(e) => { focused.current = false; commit(e.currentTarget.value); }}
          onInput={(e) => { setText(e.currentTarget.value); const r = validate(e.currentTarget.value); setError(r.ok ? '' : r.msg); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1, e.shiftKey); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1, e.shiftKey); }
          }}
        />
        {unit ? <span class="input-unit">{unit}</span> : null}
      </div>
    </Field>
  );
}

/**
 * Range slider with Persian value display and reset. onInput = live change
 * (no history), onCommit = change finished (record history once).
 */
export function Slider({ label, value, min, max, step = 1, onInput, onCommit, defaultValue = 0, format, disabled, hint }) {
  const id = useId();
  const startRef = useRef(null);
  const shown = format ? format(value) : formatNumber(value, { maxFraction: 1 });
  const begin = () => { if (startRef.current == null) startRef.current = value; };
  const end = (v) => { if (startRef.current != null) { const s = startRef.current; startRef.current = null; onCommit?.(v, s); } };
  return (
    <div class={`slider ${value !== defaultValue ? 'changed' : ''}`}>
      <div class="slider-head">
        <label for={id}>{label}</label>
        <span class="btn-row">
          {value !== defaultValue && !disabled ? (
            <button type="button" class="icon-btn sm reset" aria-label={`بازنشانی ${label}`} data-tip="بازنشانی" onClick={() => { startRef.current = value; onInput?.(defaultValue); end(defaultValue); }}>
              <Icon name="rotate-ccw" />
            </button>
          ) : null}
          <output class="value" for={id}>{shown}</output>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={shown}
        onPointerDown={begin}
        onKeyDown={begin}
        onFocus={() => {}}
        onInput={(e) => { begin(); onInput?.(Number(e.currentTarget.value)); }}
        onChange={(e) => end(Number(e.currentTarget.value))}
      />
      {hint ? <div class="hint">{hint}</div> : null}
    </div>
  );
}

export function Select({ label, value, onChange, options, disabled, hint }) {
  const id = useId();
  return (
    <Field label={label} id={id} hint={hint}>
      <select id={id} class="select" value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map((o) => (o.group
          ? <optgroup label={o.group} key={o.group}>{o.options.map((x) => <option value={x.value} key={x.value} disabled={x.disabled}>{x.label}</option>)}</optgroup>
          : <option value={o.value} key={o.value} disabled={o.disabled}>{o.label}</option>))}
      </select>
    </Field>
  );
}

export function Segmented({ label, value, onChange, options, disabled }) {
  return (
    <div class="field">
      {label ? <div class="field-label" id={`${label}-lbl`}>{label}</div> : null}
      <div class="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button type="button" key={o.value} aria-pressed={String(value === o.value)} disabled={disabled || o.disabled} title={o.title} onClick={() => onChange(o.value)}>
            {o.icon ? <Icon name={o.icon} size={16} /> : null}{o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Switch({ label, checked, onChange, disabled, hint }) {
  return (
    <div class="field">
      <label class={`switch ${disabled ? 'disabled' : ''}`}>
        <span>{label}</span>
        <input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
        <span class="track" aria-hidden="true" />
      </label>
      {hint ? <div class="hint">{hint}</div> : null}
    </div>
  );
}

export function Notice({ kind = 'info', icon, children, title }) {
  const ic = icon || { info: 'info', warn: 'triangle-alert', err: 'circle-x', ok: 'circle-check' }[kind];
  return (
    <div class={`notice ${kind}`} role={kind === 'err' ? 'alert' : 'note'}>
      <Icon name={ic} />
      <div>{title ? <strong>{title}</strong> : null}{children}</div>
    </div>
  );
}

export function Badge({ kind = '', icon, children }) {
  return <span class={`badge ${kind}`}>{icon ? <Icon name={icon} /> : null}{children}</span>;
}

export function Progress({ value }) {
  const ind = value == null;
  return (
    <div class={`progress ${ind ? 'indeterminate' : ''}`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={ind ? undefined : Math.round(value * 100)}>
      <span style={{ width: `${ind ? 35 : Math.round(value * 100)}%` }} />
    </div>
  );
}

export function Empty({ icon = 'image', title, children, action }) {
  return (
    <div class="empty">
      <div class="empty-icon"><Icon name={icon} /></div>
      <h3>{title}</h3>
      {children ? <p class="muted small">{children}</p> : null}
      {action}
    </div>
  );
}

export function Group({ title, children, actions }) {
  return (
    <section class="group">
      {title ? <h3 class="group-title"><span>{title}</span>{actions ? <span class="actions">{actions}</span> : null}</h3> : null}
      {children}
    </section>
  );
}

/** Hidden file input triggered by a button. */
export function FilePick({ accept, multiple, capture, onFiles, children, variant, icon, size, disabled, label }) {
  const ref = useRef(null);
  return (
    <>
      <Button variant={variant} icon={icon} size={size} disabled={disabled} aria-label={label} onClick={() => ref.current?.click()}>{children}</Button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        capture={capture}
        hidden
        onChange={(e) => { const f = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; if (f.length) onFiles(f); }}
      />
    </>
  );
}

/** Modal dialog shell (native <dialog>): focus on open, Esc cancels. */
export function Modal({ title, children, footer, wide, onCancel, class: cls = '', bodyClass = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      try { d.showModal(); } catch { d.setAttribute('open', ''); }
    }
    const first = d?.querySelector('[data-autofocus]') || d?.querySelector('button, input, select');
    first?.focus();
  }, []);
  return (
    <dialog ref={ref} class={`modal ${wide ? 'wide' : ''} ${cls}`} aria-labelledby="dlg-title" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <div class="modal-head">
        <h2 id="dlg-title">{title}</h2>
        <IconButton icon="x" label="بستن" onClick={onCancel} />
      </div>
      <div class={`modal-body ${bodyClass}`}>{children}</div>
      {footer ? <div class="modal-foot">{footer}</div> : null}
    </dialog>
  );
}
