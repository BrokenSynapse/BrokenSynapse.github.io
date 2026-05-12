// LMI shared config. Keep URLs and module list here instead of hardcoding them into each page.
window.LMI_CONFIG = {
  productName: 'Leviathan Military Interlink',
  defaultLoginUrl: 'https://docs.google.com/spreadsheets/d/1jLVDpy5c8j_hBViQCP_CWOqZFgp13yZRcstZ-Rjlqhk/edit?usp=sharing',
  defaultItemUrl: 'https://docs.google.com/spreadsheets/d/16DjiyWUrbcFl8tlk0A-BcjLSMB44_7-vbI6OB_Fhj98/edit?usp=sharing',
  defaultCustomerUrl: 'https://docs.google.com/spreadsheets/d/1wQVB2UkVvNuoT_iIfGZiwz8KNGj-CKwJtaPC2CpHZEk/edit?usp=sharing',
  defaultDealershipUrl: 'https://docs.google.com/spreadsheets/d/1vGdkJB71iIrslp9E7kCKSwaKH3i3o67IjVezldrM6xU/edit?usp=sharing',
  defaultThemeUrl: 'https://docs.google.com/spreadsheets/d/1JPnADM20ifQynvvwW4GufLGmP03v6XyL06edyynsp9s/edit?usp=sharing',
  modules: [
  {
    "id": "bipac",
    "name": "BIPAC.LMX",
    "file": "BIPAC.html",
    "icon": "BP",
    "desc": "Package manager / access catalog",
    "w": 980,
    "h": 700
  },
  {
    "id": "pos",
    "name": "POS.LMX",
    "file": "POS.html",
    "icon": "⧉",
    "desc": "Point of sale / catalog register",
    "w": 1240,
    "h": 820
  },
  {
    "id": "convert",
    "name": "Convert.LMX",
    "file": "Convert.html",
    "icon": "⇄",
    "desc": "Currency and unit conversion",
    "w": 820,
    "h": 620
  },
  {
    "id": "bank",
    "name": "Bank.LMX",
    "file": "Bank.html",
    "icon": "◈",
    "desc": "Account ledger / transaction history",
    "w": 980,
    "h": 720
  },
  {
    "id": "work",
    "name": "Work.LMX",
    "file": "Work.html",
    "icon": "$",
    "desc": "Occupation minigames / payout loop",
    "w": 1050,
    "h": 760
  },
  {
    "id": "browser",
    "name": "Browser.LMX",
    "file": "Browser.html",
    "icon": "B",
    "desc": "Low data relay browser",
    "w": 1000,
    "h": 700
  },
  {
    "id": "chat",
    "name": "Chat.LMX",
    "file": "Chat.html",
    "icon": "#",
    "desc": "Internal comms board",
    "w": 860,
    "h": 680
  },
  {
    "id": "bodystats",
    "name": "Bodystats.LMX",
    "file": "Bodystats.html",
    "icon": "☤",
    "desc": "Augment map / body stat module",
    "w": 1040,
    "h": 760
  },
  {
    "id": "settings",
    "name": "Settings.LMX",
    "file": "Settings.html",
    "icon": "⚙",
    "desc": "Shared URLs / keys / runtime settings",
    "w": 900,
    "h": 720
  }
]
};
