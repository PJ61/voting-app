cd ~/Desktop/VotingApp
cat > poller.js << 'EOF'
// Polls Railway every second and sends results via OSC locally
const osc = require('osc');
const https = require('https');

const RAILWAY_URL = 'voting-app-production-a381.up.railway.app';
const OSC_HOST    = '127.0.0.1';  // TouchOSC IP
const OSC_PORT    = 9000;

const udp = new osc.UDPPort({
  localAddress: '0.0.0.0', localPort: 0,
  remoteAddress: OSC_HOST, remotePort: OSC_PORT
});
udp.open();

function send(addr, args) {
  try { udp.send({ address: addr, args }); } catch(e) {}
}

function poll() {
  https.get({ host: RAILWAY_URL, path: '/api/results' }, (res) => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try {
        const r = JSON.parse(data);
        send('/poll/title',           [{ type:'s', value: r.title }]);
        send('/poll/question',        [{ type:'s', value: r.question }]);
        send('/poll/question_number', [{ type:'i', value: r.qnum }]);
        send('/poll/question_total',  [{ type:'i', value: r.qtotal }]);
        send('/poll/status',          [{ type:'s', value: r.isOpen ? 'OPEN' : 'CLOSED' }]);
        send('/poll/total_votes',     [{ type:'i', value: r.totalVotes }]);
        send('/poll/option_count',    [{ type:'i', value: r.activeOptionCount }]);
        for (let i = 1; i <= 20; i++) {
          const o = r.opts[i-1];
          send('/poll/option/'+i+'/name',    [{ type:'s', value: o ? o.name    : '' }]);
          send('/poll/option/'+i+'/votes',   [{ type:'i', value: o ? o.votes   : 0  }]);
          send('/poll/option/'+i+'/percent', [{ type:'i', value: o ? o.percent : 0  }]);
        }
        send('/poll/winner/name',    [{ type:'s', value: r.winner ? r.winner.name    : '' }]);
        send('/poll/winner/percent', [{ type:'i', value: r.winner ? r.winner.percent : 0  }]);
        send('/poll/summary', [{ type:'s', value: r.opts.map(o=>o.name+': '+o.percent+'%').join(' | ') }]);
        console.log('Polled: ' + r.totalVotes + ' votes, Q' + r.qnum);
      } catch(e) { console.error('Parse error:', e.message); }
    });
  }).on('error', e => console.error('Poll error:', e.message));
}

// Poll every second
setInterval(poll, 1000);
poll();
console.log('Poller running — fetching from Railway, sending OSC locally');
EOF
