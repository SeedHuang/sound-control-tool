// server/src/logs.test.ts(2026-09-29 用户反馈:诊断日志)
import { describe, expect, it, vi } from 'vitest';
import { getLogs, pushLog } from './logs.js';

describe('logs 环形缓冲(容量 500,丢最旧)', () => {
  it('pushLog → getLogs newest last,ts 为 ISO 时间', () => {
    const before = getLogs().length;
    pushLog('info', 'server', '第一条');
    pushLog('error', 'job', '第二条');
    const logs = getLogs();
    expect(logs.length).toBe(before + 2);
    expect(logs[logs.length - 1]?.message).toBe('第二条');
    expect(logs[0]?.ts).toContain('T'); // ISO 时间戳
  });

  it('error 级别同步 console.error(dev 终端可见)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pushLog('error', 'job', '炸了');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain('炸了');
    spy.mockRestore();
  });

  it('info 级别不触发 console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pushLog('info', 'server', '静默');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('超过容量丢最旧:push 505 → 恰剩 500 条,开头 log-6 结尾 log-505', () => {
    // 前序用例只 push 了 4 条,505 条新日志会把它们全部挤出,断言与执行顺序解耦
    for (let i = 1; i <= 505; i++) pushLog('info', 'server', `log-${i}`);
    const logs = getLogs();
    expect(logs.length).toBe(500);
    expect(logs[0]?.message).toBe('log-6');
    expect(logs[logs.length - 1]?.message).toBe('log-505');
  });
});
