import { describe, expect, it } from 'vitest';
import { parsePortFile } from './parse-port-file.js';

describe('parsePortFile(回退链第一环,双跑/脏文件是真实场景)', () => {
  it('合法 JSON 返回 port/pid/token', () => {
    expect(parsePortFile('{"port":7311,"pid":123,"token":"abc"}')).toEqual({
      port: 7311,
      pid: 123,
      token: 'abc',
    });
  });
  it('垃圾内容 / 缺字段 / 非法端口 → null', () => {
    expect(parsePortFile('not json')).toBeNull();
    expect(parsePortFile('{"pid":1}')).toBeNull();
    expect(parsePortFile('{"port":99999,"pid":1,"token":"abc"}')).toBeNull();
    expect(parsePortFile('{"port":"7311","pid":1,"token":"abc"}')).toBeNull();
  });
  it('缺 token / token 非字符串 / token 为空 → null', () => {
    expect(parsePortFile('{"port":7311,"pid":123}')).toBeNull();
    expect(parsePortFile('{"port":7311,"pid":123,"token":42}')).toBeNull();
    expect(parsePortFile('{"port":7311,"pid":123,"token":""}')).toBeNull();
  });
});
