var events = require('events'),
    util = require('util'),
    os = require('os'),
    net = require('net'),
    fs = require('fs'),
    dgram = require('dgram'),
    crypto = require('crypto'),
    ifeDriver = require('ife'),
    ife = new ifeDriver(),
    VippyConf;

VippyConfig = function(file, hostname) {
  this._hostname = hostname || os.hostname();
  this._config = {};
  this._secret = '';
  var data = fs.readFileSync(file, 'utf-8');
  this._config = JSON.parse(data);

  // Setup logging, if any
  if(this._config.logging.driver == "console") {
    this._logger = require('./console-logger');
  }
  else if(this._config.logging.driver == "syslog") {
    this._logger = require('posix');
  }
  delete this._config.secret;
  if(this._logger) {
    this._logger.openlog(process.argv[1].split(/\//).pop(), {}, this._config.logging.facility || 'local7')
    if(this._config.logging.mask) this._logger.setlogmask(this._config.logging.mask);
  }

  // Normalize the VIP entries.
  for (var i in this._config.vips) {
    var vlist = this._config.vips[i];
    for (var j in vlist) {
      if(typeof(vlist[j]) === "string") continue;
      var replace = ip2iface(vlist[j].ip);
      replace.name = vlist[j].interface;
      vlist[j] = replace;
    }
  }
  var vlist = this._config.notify;
  for (var j in vlist) {
    if(typeof(vlist[j]) === "string") continue;
    var replace = ip2iface(vlist[j].ip);
    replace.name = vlist[j].interface;
    vlist[j] = replace;
  }

  // Stash the secret
  this._secret = this._config.secret;
  // Initial arp-cache population
  this.refresh_arpcache();
};
util.inherits(VippyConfig, events.EventEmitter);

var ip2iface = function (ip_w_mask) {
  var parts = ip_w_mask.split(/\//);
  if(parts == null || !net.isIPv4(parts[0])) return null;
  var ip = parts[0], mask = (parts[1] === undefined) ? 32 : parseInt(parts[1]);
  if(mask > 32 || mask < 0) return null;
  var p = ip.split(/\./).map(function (x) { return parseInt(x); });
  var nm = [ 0, 0, 0, 0 ];
  for (var i=0; i<4; i++) {
    var bits = mask - (i * 8);
    if(bits > 7) nm[i] = 255;
    else if(bits > 0) nm[i] = 255 >> (8-bits) << (8-bits);
  }
  var bc = p.map(function(x,i) { return x | (~nm[i] & 0xff); });
  var nw = p.map(function(x,i) { return x & nm[i]; });
  
  return { 'ip': p.join('.'),
           'netmask': nm.join('.'),
           'broadcast': bc.join('.'),
           'network': nw.join('.') };
};

VippyConfig.prototype.hostname = function() {
  return this._hostname;
};

VippyConfig.prototype.log = function(pri, mess) {
  if(this._logger) this._logger.syslog(pri, mess);
};

VippyConfig.prototype.generation = function() {
  return this._lastConfigChange;
};

VippyConfig.prototype.mature = function() {
  var age = new Date() - this._lastConfigChange;
  var mature = this._config.mature || 5;
  return age > (mature * 1000);
};

VippyConfig.prototype.stale = function() {
  return this._config.stale || 3;
};

VippyConfig.prototype.active = function(v) {
  if(v !== undefined) this._active = v;
  if(!this.mature()) return false;
  if(this._active !== undefined) return this._active;
  return true;
};

VippyConfig.prototype.vips = function() {
  return this._config.vips;
};

VippyConfig.prototype.notify = function() {
  return this._config.notify;
};

VippyConfig.prototype.configHash = function(conf, nonce) {
  var sorter = function(a,b) {
    if(a['ip'] < b['ip']) return -1;
    if(a['ip'] > b['ip']) return 1;
    return 0;
  };
  str = conf.vips.map(function(vif) {
    return vif.sort(sorter).map(function(vip) {
      if(typeof(vip) === "string") return vip;
      return vip['ip']
    }).join(',');
  }).join("\n");
  str = str + "\n" + conf.nodes.join('|');
  str = str + "\n" + this._secret + "\n";
  var shasum = crypto.createHash('sha256');
  if(this._lastConfig != str) {
    this._lastConfig = str;
    this._lastConfigChange = +(new Date());
  }
  str = str + nonce;
  shasum.update(str);
  return shasum.digest('hex');
};

VippyConfig.prototype.refresh_arpcache = function() {
  var t = ife.arpcache(), count = 0;
  this._private_arp_cache = {};
  for(var ip in t) {
    var octets = ip.split(/\./);
    // skip IP multicast
    if(octets[0] >= 224 && octets[0] <= 239) continue;
    this._private_arp_cache[ip] = t[ip];
    this.log('debug', 'arp-cache ' + ip + ' is ' + t[ip]);
    count++;
  }
  this.log('info', 'arp-cache repopulated with ' + count + ' entries');
}

VippyConfig.prototype.announce = function() {
  var nonce = crypto.pseudoRandomBytes(32).toString('hex');
  var message = {
    me: this._hostname,
    active: this.active(),
    vips: this._config.vips,
    nodes: this._config.nodes,
    hash: this.configHash(this._config, nonce),
    nonce: nonce,
    arpcache: this._private_arp_cache,
  };
  var payload = new Buffer(JSON.stringify(message));
  this.log('debug', 'sending announcmment');
  this._client.send(payload, 0, payload.length, this._chatport, this._chataddr);
}

VippyConfig.prototype.run = function() {
  var vc = this;
  if(vc._running) return;
  vc._running = true;
  vc._client = dgram.createSocket("udp4");
  var addr = vc._config.chat.split(':');
  vc._chatport = parseInt(addr[1]);
  vc._chataddr = addr[0];
  var completeBind = function() {
    vc._client.addMembership(vc._chataddr);
    vc._client.setBroadcast(true);
    vc._client.setMulticastTTL(128);
    vc._client.on('message', function(data, rinfo) {
      var inbound = JSON.parse(data.toString('utf-8'));
      var expected = vc.configHash(vc._config, inbound.nonce);
      if(inbound['hash'] != expected) {
        vc.log('info', 'announcement ignored [' + rinfo.address + ']: bad hash');
        vc.emit('ignore', 'hash', inbound, rinfo);
      }
      else {
        var good = false;
        for(var idx in vc._config.nodes) {
          if(vc._config.nodes[idx] == inbound['me']) {
            vc.emit('announce', inbound, rinfo);
            good = true;
          }
        }
        if(!good) {
          vc.log('info', 'announcement ignored [' + rinfo.address + ']: bad node ' + inbound['me']);
          vc.emit('ignore', 'node', inbound, rinfo);
        }
      }
    });
    vc._chatJob = setInterval(function() {
      vc.announce();
    }, 1000 * (vc._config.interval || 1));
  };
  vc._client.bind(vc._chatport);
  completeBind();
  vc._arpJob = setInterval(function() {
    vc.refresh_arpcache();
  }, (vc._config['arp-cache'] || 15) * 1000);
}

VippyConfig.prototype.stop = function() {
  if(this._running) {
    clearInterval(this._arpJob);
    clearInterval(this._chatJob);
    this._client.close();
    delete this._client;
    this._running = false;
  }
}

module.exports = VippyConfig;