# -*- coding: utf-8 -*-
"""
_build.py — 组装 index.html
用法：python _build.py [--check]
  --check  只校验，不写文件
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import _content as C  # noqa: E402

OUT = os.path.join(HERE, 'index.html')
CHECK_ONLY = '--check' in sys.argv


def read(name):
    with open(os.path.join(HERE, name), 'r', encoding='utf-8') as f:
        return f.read()


def build_app_data():
    return {
        'title': C.COURSE_TITLE,
        'lsPrefix': C.LS_PREFIX,
        'orgName': C.ORG_NAME,
        'aiBaseUrl': 'https://api.xiaomimimo.com/v1',
        'aiModel': 'mimo-v2.5-pro',
        'allowedHosts': ['ruanqiaoyun0-a11y.github.io', 'localhost', '127.0.0.1'],
        'sections': C.SECTIONS,
        'chapterQuizzes': C.CHAPTER_QUIZZES,
        'practiceDims': C.PRACTICE_DIMS,
        'finalSystemPrompt': C.FINAL_SYSTEM_PROMPT,
        'scoringPrompt': C.SCORING_PROMPT,
        'fallbackReplies': C.FALLBACK_REPLIES,
        'topicTags': C.TOPIC_TAGS,
    }


HEAD = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="面向线上少儿数学思维班主任（LP）的《异议处理实战》互动微课">
<title>{title} · 班主任微课</title>
<style>
{css}
</style>
</head>
'''


def main():
    css = read('_shell.css') + '\n' + read('_additions.css')
    shell = read('_shell.html')
    js = read('_app.tpl.js')
    app = build_app_data()

    # 关键断言：JSON 里若含 </script 会截断 script 标签
    data_json = json.dumps(app, ensure_ascii=False, separators=(',', ':'))
    assert '</script' not in data_json.lower(), 'JSON 中包含 </script，需转义处理'

    html = (
        HEAD.format(title=C.COURSE_TITLE, css=css)
        + shell
        + '\n<!-- ===== 课程数据（JSON） ===== -->\n'
        + '<script id="appDataJson" type="application/json">' + data_json + '</script>\n'
        + '\n<!-- ===== 应用逻辑 ===== -->\n'
        + '<script>\n' + js + '\n</script>\n'
        + '</body>\n</html>\n'
    )

    # ---------- 校验 ----------
    problems = []
    if re.search(r'\{\{[A-Z_]+\}\}', html):
        problems.append('存在未替换的 {{PLACEHOLDER}} 占位符')
    if '<script' not in html or '</script>' not in html:
        problems.append('script 标签缺失')
    if 'quiz-locked-hint' not in html:
        problems.append('缺少串行锁定样式/提示')
    if 'practiceTextarea' not in html:
        problems.append('缺少第3章练习输入框')
    if 'roleplayContainer' not in html:
        problems.append('缺少终极考核挂载点')
    if 'placeholder="MIMO_API_KEY"' in html:
        problems.append('异常：出现密钥占位串')
    if "'__MIMO_API_KEY__'" not in html:
        problems.append('缺少密钥注入占位符 __MIMO_API_KEY__（_build.js 需要）')
    # 章节 / 题目数量：题目 DOM 由 JS 运行时生成，校验生成模板与数据条数
    if "chquiz-' + chIdx + '-' + qi" not in js:
        problems.append('缺少题目 DOM 生成模板')
    if "feedback-chquiz-' + chIdx + '-' + qi" not in js:
        problems.append('缺少题目反馈 DOM 生成模板')
    for i, qs in enumerate(C.CHAPTER_QUIZZES):
        if not isinstance(qs, list):
            problems.append('第 %d 章测验数据格式错误' % (i + 1))
        for qi, q in enumerate(qs):
            if not all(k in q for k in ('q', 'opts', 'correct')):
                problems.append('第 %d 章第 %d 题字段缺失' % (i + 1, qi + 1))
            elif not (0 <= q['correct'] < len(q['opts'])):
                problems.append('第 %d 章第 %d 题 correct 越界' % (i + 1, qi + 1))
    # 明文密钥
    if re.search(r'sk-[A-Za-z0-9]{20,}', html):
        problems.append('严重：index.html 中出现明文密钥 sk-...')

    print('章节数：', len(C.SECTIONS))
    print('章节测验题总数：', sum(len(x) for x in C.CHAPTER_QUIZZES))
    print('练习维度数：', len(C.PRACTICE_DIMS), ' 权重和：', sum(d['max'] for d in C.PRACTICE_DIMS))
    print('index.html 字节数：', len(html.encode('utf-8')))
    if problems:
        print('\n❌ 校验未通过：')
        for p in problems:
            print('  -', p)
        sys.exit(1)
    print('✅ 校验通过')

    if CHECK_ONLY:
        print('（--check 模式，未写文件）')
        return
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print('已写出：', OUT)


if __name__ == '__main__':
    main()
