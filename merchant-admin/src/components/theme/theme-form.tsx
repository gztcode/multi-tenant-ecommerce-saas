'use client';

import { useState } from 'react';

export interface ColorToken {
  key: string;
  label: string;
  cssVar: string;
  defaultValue: string;
}

export interface ScalarToken {
  key: string;
  label: string;
  cssVar: string;
  defaultValue: string;
}

export interface ThemeSchema {
  colors: ColorToken[];
  radius: ScalarToken;
  fonts: ScalarToken[];
  textScale: ScalarToken[];
  weights: ScalarToken[];
  spacing: ScalarToken[];
  shadows: ScalarToken[];
}

export function ThemeForm({
  schema,
  initial,
  onSave,
}: {
  schema: ThemeSchema;
  initial: Record<string, unknown>;
  onSave: (tokens: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * 更新某个分组里的某个 token。
   *
   * 整个表单只有**一个** state（draft），不为 30 多个 token 各开一个 useState。
   * 分组结构是 `Record<groupName, Record<tokenKey, string>>`，
   * 顶层标量（radius / fontSans / fontMono）单独处理。
   */
  function setGroupToken(
    group: string,
    key: string,
    value: string,
  ) {
    setDraft((prev) => ({
      ...prev,
      [group]: {
        ...((prev[group] as Record<string, string> | undefined) ?? {}),
        [key]: value,
      },
    }));
  }

  function setTopLevel(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function valueOf(group: string, key: string, fallback: string): string {
    const bucket = draft[group] as Record<string, string> | undefined;
    return bucket?.[key] ?? fallback;
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      await onSave(draft);
      setMessage('已保存');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  /** 渲染一组标量 token 的输入框 */
  function renderScalars(
    group: string,
    definitions: Array<{ key: string; label: string; defaultValue: string }>,
  ) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {definitions.map((token) => (
          <label key={token.key} className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{token.label}</span>
            <input
              type="text"
              className="rounded-md border px-2 py-1"
              value={valueOf(group, token.key, token.defaultValue)}
              onChange={(e) =>
                setGroupToken(group, token.key, e.target.value)
              }
            />
          </label>
        ))}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <h3 className="text-lg font-semibold">店铺主题</h3>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">颜色</h4>
        {renderScalars('colors', schema.colors)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">圆角与字体</h4>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{schema.radius.label}</span>
            <input
              type="text"
              className="rounded-md border px-2 py-1"
              value={String(draft.radius ?? schema.radius.defaultValue)}
              onChange={(e) => setTopLevel('radius', e.target.value)}
            />
          </label>
          {schema.fonts.map((token) => (
            <label key={token.key} className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{token.label}</span>
              <input
                type="text"
                className="rounded-md border px-2 py-1"
                value={String(draft[token.key] ?? token.defaultValue)}
                onChange={(e) => setTopLevel(token.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">字阶</h4>
        {renderScalars('textScale', schema.textScale)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">字重</h4>
        {renderScalars('weights', schema.weights)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">间距</h4>
        {renderScalars('spacing', schema.spacing)}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">阴影</h4>
        {renderScalars('shadows', schema.shadows)}
      </div>

      <button
        type="button"
        className="w-fit rounded-md bg-primary px-4 py-2 text-primary-foreground"
        disabled={saving}
        onClick={handleSave}
      >
        {saving ? '保存中…' : '保存主题'}
      </button>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}