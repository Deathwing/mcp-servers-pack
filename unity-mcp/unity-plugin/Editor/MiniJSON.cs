// MiniJSON — minimal JSON parser/serializer (no external dependencies).
// Handles nested dicts, arrays, strings, numbers, booleans, null.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace UnityMCP
{
    public static class MiniJSON
    {
        public static object Deserialize(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            return Parser.Parse(json);
        }

        public static string Serialize(object obj)
        {
            return Serializer.Serialize(obj);
        }

        private sealed class Parser : IDisposable
        {
            private StringReader _reader;

            public static object Parse(string json)
            {
                using (var parser = new Parser(json))
                    return parser.ParseValue();
            }

            private Parser(string json) { _reader = new StringReader(json); }

            public void Dispose() { _reader?.Dispose(); }

            private object ParseValue()
            {
                SkipWhitespace();
                var c = PeekChar();
                switch (c)
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return ParseString();
                    case '-':
                    case '0': case '1': case '2': case '3': case '4':
                    case '5': case '6': case '7': case '8': case '9':
                        return ParseNumber();
                    default:
                        return ParseLiteral();
                }
            }

            private Dictionary<string, object> ParseObject()
            {
                ReadChar(); // consume '{'
                var dict = new Dictionary<string, object>();

                while (true)
                {
                    SkipWhitespace();
                    if (PeekChar() == '}') { ReadChar(); return dict; }
                    if (dict.Count > 0) { Expect(','); SkipWhitespace(); }
                    var key = ParseString();
                    SkipWhitespace();
                    Expect(':');
                    dict[key] = ParseValue();
                }
            }

            private List<object> ParseArray()
            {
                ReadChar(); // consume '['
                var list = new List<object>();

                while (true)
                {
                    SkipWhitespace();
                    if (PeekChar() == ']') { ReadChar(); return list; }
                    if (list.Count > 0) { Expect(','); }
                    list.Add(ParseValue());
                }
            }

            private string ParseString()
            {
                Expect('"');
                var sb = new StringBuilder();
                while (true)
                {
                    var c = ReadChar();
                    if (c == '"') return sb.ToString();
                    if (c == '\\')
                    {
                        c = ReadChar();
                        switch (c)
                        {
                            case '"': case '\\': case '/': sb.Append(c); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                var hex = new char[4];
                                for (int i = 0; i < 4; i++) hex[i] = ReadChar();
                                sb.Append((char)Convert.ToInt32(new string(hex), 16));
                                break;
                        }
                    }
                    else
                    {
                        sb.Append(c);
                    }
                }
            }

            private object ParseNumber()
            {
                var sb = new StringBuilder();
                var isFloat = false;

                while (true)
                {
                    var c = PeekChar();
                    if (c == '.' || c == 'e' || c == 'E') isFloat = true;
                    if (char.IsDigit(c) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
                    {
                        sb.Append(ReadChar());
                    }
                    else break;
                }

                var s = sb.ToString();
                if (isFloat)
                {
                    if (double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out double d))
                        return d;
                }
                else
                {
                    if (long.TryParse(s, out long l))
                    {
                        if (l >= int.MinValue && l <= int.MaxValue) return (int)l;
                        return l;
                    }
                }
                return 0;
            }

            private object ParseLiteral()
            {
                var sb = new StringBuilder();
                while (char.IsLetter(PeekChar())) sb.Append(ReadChar());
                var s = sb.ToString();
                if (s == "true") return true;
                if (s == "false") return false;
                if (s == "null") return null;
                throw new Exception($"Unexpected literal: {s}");
            }

            private void SkipWhitespace()
            {
                while (char.IsWhiteSpace(PeekChar())) ReadChar();
            }

            private char PeekChar()
            {
                var c = _reader.Peek();
                return c < 0 ? '\0' : (char)c;
            }

            private char ReadChar()
            {
                var c = _reader.Read();
                if (c < 0) throw new Exception("Unexpected end of JSON");
                return (char)c;
            }

            private void Expect(char expected)
            {
                var c = ReadChar();
                if (c != expected) throw new Exception($"Expected '{expected}' but got '{c}'");
            }
        }

        private sealed class Serializer
        {
            private readonly StringBuilder _sb = new();

            public static string Serialize(object obj)
            {
                var s = new Serializer();
                s.SerializeValue(obj);
                return s._sb.ToString();
            }

            private void SerializeValue(object obj)
            {
                if (obj == null) { _sb.Append("null"); return; }
                if (obj is string str) { SerializeString(str); return; }
                if (obj is bool b) { _sb.Append(b ? "true" : "false"); return; }
                if (obj is IDictionary<string, object> dict) { SerializeObject(dict); return; }
                if (obj is IList<object> list) { SerializeArray(list); return; }
                if (obj is IList<string> sList) { SerializeStringList(sList); return; }
                if (obj is int || obj is long || obj is float || obj is double)
                {
                    _sb.Append(Convert.ToString(obj, CultureInfo.InvariantCulture));
                    return;
                }
                SerializeString(obj.ToString());
            }

            private void SerializeObject(IDictionary<string, object> dict)
            {
                _sb.Append('{');
                bool first = true;
                foreach (var kv in dict)
                {
                    if (!first) _sb.Append(',');
                    first = false;
                    SerializeString(kv.Key);
                    _sb.Append(':');
                    SerializeValue(kv.Value);
                }
                _sb.Append('}');
            }

            private void SerializeArray(IList<object> list)
            {
                _sb.Append('[');
                for (int i = 0; i < list.Count; i++)
                {
                    if (i > 0) _sb.Append(',');
                    SerializeValue(list[i]);
                }
                _sb.Append(']');
            }

            private void SerializeStringList(IList<string> list)
            {
                _sb.Append('[');
                for (int i = 0; i < list.Count; i++)
                {
                    if (i > 0) _sb.Append(',');
                    SerializeString(list[i]);
                }
                _sb.Append(']');
            }

            private void SerializeString(string str)
            {
                _sb.Append('"');
                foreach (var c in str)
                {
                    switch (c)
                    {
                        case '"': _sb.Append("\\\""); break;
                        case '\\': _sb.Append("\\\\"); break;
                        case '\b': _sb.Append("\\b"); break;
                        case '\f': _sb.Append("\\f"); break;
                        case '\n': _sb.Append("\\n"); break;
                        case '\r': _sb.Append("\\r"); break;
                        case '\t': _sb.Append("\\t"); break;
                        default:
                            if (c < 0x20)
                                _sb.Append($"\\u{(int)c:X4}");
                            else
                                _sb.Append(c);
                            break;
                    }
                }
                _sb.Append('"');
            }
        }
    }
}

#endif
