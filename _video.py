# -*- coding: utf-8 -*-
"""
_video.py — 生产 10 段 AI 配音讲解短视频
链路：幻灯片 HTML → Chrome headless 截图(1280x720 PNG) → edge-tts 旁白(mp3)
      → PyAV(libx264 + aac) 合片，带 movflags=+faststart

用法：
  python _video.py                全部生产
  python _video.py --only ch1_v1  只做一段（调试用）
  python _video.py --list         只打印分段清单
"""
import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SLIDES = os.path.join(HERE, '_slides')
AUDIO = os.path.join(SLIDES, 'audio')
PY = r'C:\Users\PC\.workbuddy\binaries\python\envs\default\Scripts\python.exe'
EDGE_TTS = r'C:\Users\PC\.workbuddy\binaries\python\envs\default\Scripts\edge-tts.exe'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
VOICE = 'zh-CN-XiaoxiaoNeural'
RATE = '+15%'
FPS = 15
W, H = 1280, 720

# ============================================================
# 幻灯片模板
# ============================================================
SLIDE_TPL = '''<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:1280px;height:720px;font-family:"Microsoft YaHei","PingFang SC",sans-serif;
     background:#F8FAFC;color:#1E293B;overflow:hidden;position:relative}
.top{position:absolute;top:0;left:0;right:0;height:8px;background:linear-gradient(90deg,#4338CA,#6366F1,#A5B4FC)}
.tag{position:absolute;top:42px;left:64px;background:#EEF2FF;color:#3730A3;font-size:19px;font-weight:700;
     padding:6px 20px;border-radius:20px;letter-spacing:.02em}
h1{position:absolute;top:96px;left:64px;right:64px;font-size:48px;font-weight:800;line-height:1.24;color:#1E293B}
.sub{position:absolute;top:172px;left:64px;right:64px;font-size:22px;color:#64748B;line-height:1.5}
.grid{position:absolute;top:244px;left:64px;right:64px;bottom:60px;display:flex;gap:20px;flex-wrap:wrap;
      align-content:center;align-items:stretch}
.card{flex:1;min-width:300px;background:#fff;border:2px solid #E2E8F0;border-radius:16px;padding:26px 26px;
      box-shadow:0 2px 10px rgba(15,23,42,.05);display:flex;flex-direction:column;justify-content:center}
.card h3{font-size:25px;font-weight:800;color:#3730A3;margin-bottom:12px;line-height:1.35}
.card p{font-size:19px;color:#475569;line-height:1.75}
.card.accent{border-color:#C7D2FE;background:#F5F7FF}
.card.success{border-color:#A7F3D0;background:#F0FDF9}
.card.warn{border-color:#FCD34D;background:#FFFBEB}
.flow{position:absolute;top:262px;left:64px;right:64px;bottom:80px;display:flex;gap:14px;align-items:stretch}
.step{flex:1;background:#fff;border:2px solid #E2E8F0;border-radius:16px;padding:22px 18px;text-align:center;
      box-shadow:0 2px 10px rgba(15,23,42,.05)}
.step .n{width:48px;height:48px;border-radius:50%;background:#4F46E5;color:#fff;font-size:22px;font-weight:800;
      display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
.step h3{font-size:22px;font-weight:800;color:#1E293B;margin-bottom:10px}
.step p{font-size:17px;color:#64748B;line-height:1.65}
.foot{position:absolute;bottom:22px;left:64px;right:64px;display:flex;justify-content:space-between;
      font-size:16px;color:#94A3B8}
</style></head><body>
<div class="top"></div>
<div class="tag">__TAG__</div>
<h1>__TITLE__</h1>
<div class="sub">__SUB__</div>
__BODY__
<div class="foot"><span>《异议处理实战》 · 班主任（LP）微课</span><span>VIPTHINK</span></div>
</body></html>'''


def cards(items, style=''):
    return '<div class="grid">' + ''.join(
        '<div class="card %s"><h3>%s</h3><p>%s</p></div>' % (style, h, p) for h, p in items) + '</div>'


def steps(items):
    return '<div class="flow">' + ''.join(
        '<div class="step"><div class="n">%s</div><h3>%s</h3><p>%s</p></div>' % (n, h, p) for n, h, p in items) + '</div>'


# ============================================================
# 10 段视频定义
# ============================================================
SEGMENTS = [
    dict(
        f='ch1_v1', tag='第 1 章 · 认识异议',
        title='什么是异议？', sub='它不是你沟通的障碍，而是家长把疑问交给了你',
        body=cards([
            ('💬 异议是什么', '家长对你、对产品、对价格、对服务、对质量等方面提出的质疑或不同见解'),
            ('👀 家长的关注点', '产品 · 价格 · 服务 · 质量 —— 四个维度都可能冒出异议'),
            ('🎯 关键认知', '家长说出口的那句话，往往不是他真正在意的事。找到「真正在意」，才是你的任务'),
        ]),
        narr='作为班主任，你一定遇到过这样的场景：家长一句「我们再看看」，或者「感觉没什么效果」，'
             '你准备了很久的话突然就接不下去了。这些话，就是我们说的「异议」。'
             '异议不是家长在跟你作对，而是家长把心里的疑问交给了你。'
             '家长关注的通常是四个地方：产品、价格、服务、质量，而这些都会以异议的形式表现出来。'
             '这里有一个关键认知：家长说出口的那句话，往往不是他真正在意的事。'
             '比如家长说班上人数增加了，你要想的不是人数本身，而是他真正在意的是什么——'
             '是担心老师关注度下降，还是担心孩子被忽视？'
             '你的任务，就是找到他真正在意的东西，然后去解决它。',
    ),
    dict(
        f='ch1_v2', tag='第 1 章 · 四步法',
        title='异议处理四步法', sub='倾听 → 理解 → 处理异议 → 继续流程',
        body=steps([
            ('1', '倾听', '不打断、不急于解释。让家长说完，再判断异议真假与真实担忧'),
            ('2', '理解', '先处理情绪，再处理事情。表示理解，缓和矛盾'),
            ('3', '处理异议', '结合产品与政策优势，针对性解决问题——不是把话术背一遍'),
            ('4', '继续流程', '回到原本的沟通主线，继续推进'),
        ]),
        narr='处理异议有四步，这是后面所有话术的骨架。'
             '第一步，倾听。家长提出异议时，不要打断、不要急于解释，让他把话说完，'
             '再判断这个异议是真是假，或者家长真正的担忧是什么。'
             '第二步，理解。对家长的异议表示理解，先把情绪接住。我们常说一句话：先处理情绪，再处理事情。'
             '你可以说，我非常理解您的想法，之前我也有一些家长和您有着同样的担忧。'
             '第三步，处理异议。结合产品、政策、课程、师资、服务等优势，针对性地解决家长的问题。'
             '注意是针对性，不是把话术全背一遍。'
             '第四步，继续流程。异议处理完，要回到原本的沟通流程继续推进。'
             '很多同学卡在第三步讲完就停了，忘了往前走。',
    ),
    dict(
        f='ch2_v1', tag='第 2 章 · 效果类异议',
        title='「没看到明显效果」怎么接？', sub='四条解决思路，按顺序走',
        body=steps([
            ('1', '同理着急', '先接住情绪，再往下问诊'),
            ('2', '解决效果问题', '拿证据、定位版块，给具体方案'),
            ('3', '放大孩子进步', '超出家长认识半步'),
            ('4', '理念教育', '讲清思维效果为何隐匿、周期长'),
        ]),
        narr='没看到明显效果，是续费期最高频、也最难接的一类异议。'
             '难，不是因为家长不讲道理，而是因为思维的进步本来就不好被看见。'
             '处理它，有四条思路。'
             '第一，同理家长的着急。先说一句：我们花了时间和精力，都非常期待看到孩子的进步，'
             '您提到还没看到多大效果，我也能理解您的着急。'
             '不要急着说「其实孩子进步很大」——先接住着急，再往下问诊。'
             '第二，解决效果问题。先拿到证据，让家长把卷子拍照发到群里，一起分析是哪个版块出了问题，'
             '是计算、几何还是应用题，然后针对性地给方案。'
             '第三，放大孩子的进步。家长天天跟孩子在一起，很难看到细微的变化，'
             '你要做的就是超出家长认识半步。'
             '第四，理念教育。讲清楚思维学习的效果是隐匿的，周期也更长，'
             '因为它改变的是孩子底层的思考逻辑。',
    ),
    dict(
        f='ch2_v2', tag='第 2 章 · 兴趣问题',
        title='「不想学了」——先问原因，再给方案', sub='兴趣减退的四个常见原因',
        body=cards([
            ('① 课程难易度', '提供相关练习题，或更换级别'),
            ('② 不喜欢老师', '先了解家长喜欢什么样的老师，再考虑更换老师'),
            ('③ 时间不合适', '更换上课时间'),
            ('④ 时间排满想休息', '先判断是不是真问题；如果是，就是课程重要性问题'),
        ]),
        narr='孩子对课程兴趣不大、不想学了——这句话你也不陌生。'
             '处理思路是：先表示理解，了解家长对豌豆的看法；再找到兴趣减退的原因，针对原因给方案；'
             '最后做理念教育。原因通常有四种。'
             '第一，课程难易度问题——可以提供相关练习题，或者更换级别。'
             '第二，不喜欢老师——先了解家长喜欢什么样的老师，再考虑更换老师。'
             '第三，时间不合适——更换上课时间。'
             '第四，时间排满了、孩子想休息——这一类要先了解家长给孩子排了什么课，'
             '判断这是不是真问题；如果是真问题，那就是课程重要性问题。'
             '这里可以讲一段话术：您给孩子报这么多课，证明您对孩子的学习非常关注。'
             '英语课、语文课确实重要，但数学思维课同样重要。'
             '我们豌豆的课程除了校内知识点和奥数知识点，还增加了百分之四十的思维拓展。'
             '一二年级还不明显，三年级以后，就要拿出真本事了。',
    ),
    dict(
        f='ch3_v1', tag='第 3 章 · 时机类异议',
        title='「课时还多，先不考虑」怎么破？', sub='讲完整性，不讲囤课',
        body=steps([
            ('1', '同理心，确认异议', '「如果课时这个月就学完了，您今天会给孩子报名吗？」'),
            ('2', '课程规划', '体系完整性：S1-S3 启蒙 / S4-S6 基础 / S7-S9 进阶'),
            ('3', '级别完整性', 'S4 是一个完整级别，一共 96 节课'),
            ('4', '优惠力度的差异', '现在续就是最划算的'),
        ]),
        narr='剩余课时还多，先不考虑——听到这句话，第一反应可能是着急，但请不要急着推课包。'
             '解决思路有三步。'
             '第一，同理心，确认异议。你可以说，是的咱们还有多少节课，非常理解妈妈想学完之后再报名。'
             '如果说咱们课时这个月就要学完了，那我今天跟您说这个方案，您是会给孩子报名是吧？'
             '第二，课程规划。要讲「完整性」，不要讲「囤课」。'
             '豌豆的体系是 S1 到 S3 启蒙、S4 到 S6 基础、S7 到 S9 进阶。'
             '你可以说，宝贝现在上的是 S4，我们应该把 S5、S6 完整学完，这是完整的基础体系。'
             '但我觉得没必要这么着急，我们可以学完 S4 先规划 S5，所以我先只给您规划一年的课时。'
             '注意，先规划一年，能明显降低家长的决策压力。'
             '第三，谈优惠。把它讲成差异化，而不是打折：这次的价格和之前跟您说的已经不一样了，'
             '您现在续就是最划算的，之后我就不保证还是这个价格了。',
    ),
    dict(
        f='ch3_v2', tag='第 3 章 · 时间不确定',
        title='「时间不确定」——把未知讲成确定', sub='两个关键节点：幼升小 与 2 升 3 年级',
        body=cards([
            ('🎒 幼升小要讲清三件事', '放学时间（一年级约 16:00）· 校内作业节奏 · 校外安排；以及小学与幼儿园在「上课目标」和「上课形式」上的区别'),
            ('📈 2 升 3 要讲清三个变化', '英语学科加入带来的时间挤压 · 数学难度增加 · 作业量增加'),
            ('🌱 顺势讲豌豆的价值', 'S3-S4 帮助幼小衔接；40 分钟课时让孩子提前适应小学课堂'),
            ('🛠️ 给家长一个工具', '作业规划四步法：一起规划 → 引导尝试 → 独立安排 → 试错放手'),
        ]),
        narr='后期时间不确定，到时候再说——这类异议一般集中在两个节点：幼升小和两升三年级。'
             '先同理：孩子很快要读小学了，很理解您对小学学习情况的疑惑和不确定。'
             '然后问两句：孩子接下来读哪所小学？您了解到的校内安排是怎么样的？'
             '接着客观介绍。幼升小要讲清三件事：'
             '一是放学时间，一年级周一到周五下午四点左右放学，父母一般还在工作，接送需要老人帮忙；'
             '二是校内作业，一到二年级五到六点完成，三年级六到七点，四年级以上七到八点；'
             '三是校外安排，一到二年级课外没有固定时间，以兴趣素养类为主；三年级以上基本排在周一和周五。'
             '还要讲两个关键区别：幼儿园培养的是行为习惯，小学以学习知识为主，会有考试压力；'
             '幼儿园上课是动态活跃的，小学是坐在课桌前安静自主地上完一节课。'
             '正好，我们豌豆一节课四十分钟，就是让孩子提前适应小学的课堂形式。'
             '到了两升三年级，重点讲三个变化：英语学科加入带来的时间挤压、数学难度增加、作业量增加。'
             '作业这一块，要教家长一个作业规划四步法。',
    ),
    dict(
        f='ch4_v1', tag='第 4 章 · 决策类异议',
        title='「我要跟孩子爸爸商量一下」', sub='先判断真假，再走四步',
        body=steps([
            ('1', '了解商量什么', '要具体理由；给不出 → 很可能是假问题'),
            ('2', '加强妈妈决策重要性', '谁最了解孩子，谁做规划'),
            ('3', '了解爸爸想法', '不关注 → 引导参与；觉得没效果 → 约电话'),
            ('4', '外化效果，妈妈做主', '价格锚定 + 把爸爸拉进学习群'),
        ]),
        narr='妈妈说我得跟孩子爸爸商量一下——这句你肯定听过很多次。'
             '首先要判断：这是一个真实障碍，还是家长礼貌拒绝的挡箭牌？解决办法分四步。'
             '第一步，先问清要商量什么。你可以说，妈妈要跟爸爸商量，那爸爸平时有关注孩子的学习吗？'
             '妈妈主要想跟爸爸商量什么呀？看我这边能不能帮您解决呢？'
             '如果妈妈给出了具体异议，那是真问题，先解决它；如果妈妈只是执意要商量，'
             '那这很可能就是假问题，要继续挖真实异议。'
             '第二步，讲清妈妈才是真正的规划者。孩子爸爸天天上班，孩子学习都是您在跟，'
             '他学到哪了、哪里不会，都是您最清楚。您给他规划多远，他就能走多远。'
             '第三步，了解爸爸的想法。分两种情况：爸爸不关注、觉得思维不重要，'
             '那就引导爸爸参与孩子的学习，让他看到孩子的课堂表现和进步；'
             '爸爸一直参与但觉得没效果，那就约一个电话，一起跟爸爸沟通。'
             '第四步，外化效果，强调妈妈自己做主。可以用价格锚定：如果是五万六万，确实需要得到爸爸认可；'
             '但就几千块钱，我们可以先做这个决定，再把爸爸拉进学习群，让他也看到孩子的进步。',
    ),
    dict(
        f='ch5_v1', tag='第 5 章 · 价格异议',
        title='「你们价格太贵了」怎么答？', sub='同理 → 五维对比 → 师生磨合 → 最后一手',
        body=cards([
            ('🤝 同理 + 判断真伪', '不能只单单对比价格。上课形式、一个班几个孩子、后续服务，都要看'),
            ('⚖️ 性价比五对比', '对比录播 · 对比上课形式 · 对比师资 · 对比课程 · 对比服务'),
            ('🔄 师生磨合', '换机构要重新磨合，时间成本也是成本，最后看的是效果'),
            ('💰 价格锚定与最后一手', '6000 元 ≈ 9 个月 ≈ 每月 600 多；「如果我帮您申请到其它优惠，您今天就会给孩子报名吗？」'),
        ]),
        narr='你们价格太贵了——听到这句话，千万不要马上说「这个价格已经很优惠了」。'
             '正确的路径是三步。'
             '第一步，同理心，同时判断这是不是真实异议。你可以说，我非常理解您的想法。'
             '给宝贝选择机构的时候，肯定希望孩子学得有效果，同时如果价格再美丽一些就更好了。'
             '所以咱们选择机构的时候，不能只单单对比价格——它的上课形式是怎样的，一个班有几个小朋友，'
             '后续服务是怎样的，这些都是要看的。'
             '第二步，对比突出性价比，一共五个维度：对比录播，我们采用真人在线直播，'
             '能做到眼睛看、耳朵听、嘴上说、手中做的多感官体验式学习；'
             '对比上课形式，家长可以陪伴孩子一起学习；'
             '对比师资，老师都经过严格面试筛选，至少三个月的岗前培训才能上岗；'
             '对比课程，课件一直在开发和升级迭代；对比服务，孩子有专属学习群，老师课前课后都会及时沟通。'
             '第三步，从师生磨合的角度说明，继续在豌豆学习更合适。'
             '最后做一个价格锚定：才六千块钱，至少能学九个月，算下来一个月六百多。'
             '如果家长还在犹豫，就抛出最后一手优惠：妈妈，如果我帮您跟经理申请到其它优惠，'
             '您今天就会给孩子继续报名吗？',
    ),
    dict(
        f='ch5_v2', tag='第 5 章 · 产品顾虑',
        title='「上网课伤眼睛」怎么答？', sub='同理 → 产品设计 → 正确用眼建议',
        body=cards([
            ('🌗 护眼模式', '学生端可以把屏幕亮度和色彩调到孩子看着最舒服的状态'),
            ('⏱️ 40 分钟课时', '既符合注意力习惯，也是从保护视力出发；线下课往往一小时起'),
            ('👁️ 眼保健操', '上完课做一下，让眼睛休息休息'),
            ('✅ 正确用眼四建议', '大屏保距离 · 改善照明端正坐姿 · 远眺训练做眼保健操 · 注意营养不挑食'),
        ], style='accent'),
        narr='上网课对孩子的眼睛不好——这是家长非常真实的一个顾虑。解决思路是三步。'
             '第一步，同理共情。你可以说，原来妈妈是考虑到孩子的眼睛健康问题，'
             '其实您担心的这个问题也是我们豌豆在乎的事，所以也非常能理解您的立场。'
             '第二步，介绍产品设计。豌豆的学生端本身设计了护眼模式，'
             '可以把上课屏幕的亮度和色彩调整到孩子看着最舒服的状态；'
             '每节课的时间设计在四十分钟，既符合孩子的注意力习惯，也是从保护视力出发的，'
             '很多线下课程一节课至少都是一个小时起；'
             '另外我们还设计了一套眼保健操，孩子上完课就可以做一下，让眼睛休息休息。'
             '第三步，提出正确用眼的建议。现在是全面网络时代，说不接触电子设备也难做到，'
             '所以我们做的不是杜绝电子产品，而是教孩子怎么正确合理地用眼。具体有四条：'
             '选择屏幕大一些的设备，保持合适的距离；改善照明、端正坐姿；'
             '提倡远眺训练、经常做眼保健操；注意营养、不挑食。',
    ),
    dict(
        f='ch6_v1', tag='第 6 章 · 终极考核',
        title='终极考核：AI 家长自由对话', sub='把一通电话，完整打完',
        body=cards([
            ('🎭 角色设定', '你是豌豆思维班主任；家长是乐乐妈妈，孩子 7 岁、小学一年级、S3 在读'),
            ('⚠️ 家长的两个顾虑', '① 觉得没有看到明显效果 ② 觉得价格贵，还想跟爸爸商量'),
            ('💬 对话要求', '至少 4 轮，建议 6-8 轮；系统实时给出话题提示'),
            ('📊 评分维度', '共情与关系 25 · 异议识别与诊断 25 · 方案与说服 30 · 闭环与合规 20'),
        ], style='warn'),
        narr='最后一章是终极考核。这一次，你要跟一位真实的家长，把一通电话完整打完。'
             '你的角色是豌豆思维班主任，家长是乐乐妈妈，孩子七岁、刚上小学一年级、豌豆 S3 在读。'
             '乐乐妈妈有两个主要顾虑：一是觉得没有看到明显的效果，二是觉得价格贵，还想跟爸爸商量。'
             '对话至少四轮，建议六到八轮。评分从四个维度进行：'
             '共情与关系二十五分，异议识别与诊断二十五分，方案与说服三十分，闭环与合规二十分。'
             '给你一个提示：不要急着讲课程。先把家长的情绪接住，问清他真正在意什么，'
             '再给针对性的方案，最后推进一个具体动作。整个过程不施压，也不承诺你办不到的事。',
    ),
]


def build_slide_html(seg):
    return (SLIDE_TPL
            .replace('__TAG__', seg['tag'])
            .replace('__TITLE__', seg['title'])
            .replace('__SUB__', seg['sub'])
            .replace('__BODY__', seg['body']))


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise RuntimeError('命令失败: %s\n%s\n%s' % (' '.join(cmd[:2]), r.stdout[-2000:], r.stderr[-2000:]))
    return r


def make_slide(seg):
    html = build_slide_html(seg)
    hp = os.path.join(SLIDES, seg['f'] + '.html')
    pp = os.path.join(SLIDES, seg['f'] + '.png')
    with open(hp, 'w', encoding='utf-8') as f:
        f.write(html)
    if not os.path.exists(CHROME):
        raise RuntimeError('找不到 Chrome：' + CHROME)
    run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
         '--force-device-scale-factor=1', '--window-size=%d,%d' % (W, H),
         '--screenshot=' + pp, 'file:///' + hp.replace('\\', '/')])
    if not os.path.exists(pp) or os.path.getsize(pp) < 1000:
        raise RuntimeError('截图失败：' + pp)
    return pp


def make_audio(seg):
    txt = os.path.join(AUDIO, seg['f'] + '.txt')
    mp3 = os.path.join(AUDIO, seg['f'] + '.mp3')
    with open(txt, 'w', encoding='utf-8') as f:
        f.write(seg['narr'])
    last = ''
    for attempt in range(8):
        try:
            run([EDGE_TTS, '--voice', VOICE, '--rate=' + RATE, '--file', txt, '--write-media', mp3])
            if os.path.exists(mp3) and os.path.getsize(mp3) > 2000:
                return mp3
            last = '输出过小或为空'
        except Exception as e:
            last = str(e)
        print('   TTS 第 %d 次失败，%d 秒后重试…' % (attempt + 1, 3 + attempt * 2))
        time.sleep(3 + attempt * 2)
    raise RuntimeError('TTS 生成失败：' + last)


def mux(png, mp3, out):
    import av
    from fractions import Fraction
    from PIL import Image
    with av.open(mp3) as a:
        dur = float(a.duration) / av.time_base
    if dur <= 0.5:
        raise RuntimeError('音频时长异常')
    img = Image.open(png).convert('RGB')
    if img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    n_frames = max(1, int(round(dur * FPS)))
    with av.open(out, 'w', options={'movflags': '+faststart'}) as oc:
        # 两个流必须先全部声明，再写入任何 packet（否则 muxer 不会写出 moov）
        vs = oc.add_stream('libx264', rate=FPS)
        vs.width, vs.height = W, H
        vs.pix_fmt = 'yuv420p'
        vs.bit_rate = 350000
        vs.time_base = Fraction(1, FPS)

        ac = oc.add_stream('aac', rate=44100)
        ac.bit_rate = 96000
        ac.time_base = Fraction(1, 44100)

        # ---- 视频：静态画面重复 n_frames 帧 ----
        vframe = av.VideoFrame.from_image(img).reformat(width=W, height=H, format='yuv420p')
        for i in range(n_frames):
            vframe.pts = i
            for pkt in vs.encode(vframe):
                oc.mux(pkt)
        for pkt in vs.encode():
            oc.mux(pkt)

        # ---- 音频：解码 mp3 → 重采样 → AAC ----
        with av.open(mp3) as inp:
            res = av.AudioResampler(format='fltp', layout='stereo', rate=44100)
            for af in inp.decode(inp.streams.audio[0]):
                for rf in res.resample(af):
                    rf.pts = None
                    for pkt in ac.encode(rf):
                        oc.mux(pkt)
            for rf in res.resample(None):
                for pkt in ac.encode(rf):
                    oc.mux(pkt)
        for pkt in ac.encode():
            oc.mux(pkt)
    return dur, n_frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--list', action='store_true')
    args = ap.parse_args()

    if args.list:
        for i, s in enumerate(SEGMENTS, 1):
            print('%2d  %-10s %-22s %d 字' % (i, s['f'], s['tag'], len(s['narr'])))
        print('共 %d 段，旁白合计 %d 字' % (len(SEGMENTS), sum(len(s['narr']) for s in SEGMENTS)))
        return

    os.makedirs(SLIDES, exist_ok=True)
    os.makedirs(AUDIO, exist_ok=True)
    targets = [s for s in SEGMENTS if (not args.only or s['f'] == args.only)]
    if not targets:
        print('未找到匹配分段：' + args.only)
        sys.exit(1)

    total = 0
    for s in targets:
        print('▶ %s  %s' % (s['f'], s['title']))
        png = make_slide(s)
        print('   幻灯片 ✓ (%d KB)' % (os.path.getsize(png) // 1024))
        mp3 = make_audio(s)
        print('   配音   ✓ (%d KB)' % (os.path.getsize(mp3) // 1024))
        out = os.path.join(HERE, s['f'] + '.mp4')
        dur, nf = mux(png, mp3, out)
        size = os.path.getsize(out)
        total += size
        flag = '⚠️ 超 20MB' if size > 20 * 1024 * 1024 else '✓'
        print('   合片   %s  %.1fs / %d 帧 / %d KB  %s' % (flag, dur, nf, size // 1024, ''))
    print('\n完成 %d 段，合计 %.1f MB' % (len(targets), total / 1024 / 1024))


if __name__ == '__main__':
    main()
