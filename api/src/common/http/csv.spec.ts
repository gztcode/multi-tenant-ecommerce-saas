import { escapeCsvCell, toCsv } from './csv';

describe('CSV 转义', () => {
  it('含逗号/引号/换行的字段加引号并双写引号', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('公式注入：= + - @ 开头的单元格前置单引号', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+86')).toBe("'+86");
    expect(escapeCsvCell('-12.00')).toBe("'-12.00");
    expect(escapeCsvCell('@cmd')).toBe("'@cmd");
  });

  it('空值与普通值原样输出', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell('STL-1')).toBe('STL-1');
  });
});

describe('toCsv', () => {
  it('空列表也能生成表头', () => {
    expect(toCsv(['结算单号', '净额'], [])).toBe('结算单号,净额\r\n');
  });

  it('逐行拼接并用 CRLF 结尾', () => {
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});
