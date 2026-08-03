import type { ShortTermSubTab } from '../../store/appStore'

export const SHORT_TERM_SUB_TABS: Array<[ShortTermSubTab, string]> = [
  ['morningAuction', '早盘集合竞价'],
  ['closingHalfHour', '尾盘行为'],
  ['limitBoardMonitor', '涨停板监控'],
  ['secondBoardLeader', '连板龙头'],
  ['firstYinDip', '首阴回踩'],
  ['dipBuyRadar', '低吸雷达'],
  ['strategyLab', '策略实验室'],
  ['chipMonitor', '筹码结构'],
  ['strategyBacktest', '策略评估'],
]
