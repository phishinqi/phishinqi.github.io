window.onkeydown = window.onkeyup = window.onkeypress = function (event) {
    if (event.keyCode === 123) {
      event.preventDefault();
      window.event.returnValue = false;
      volantis.message(
        '系统提示',
        '本站已禁用调试功能',
        'warning'
      );
    }
  }

window.oncontextmenu = function(event) {
	event.preventDefault(); // 阻止默认事件行为
    return false;
}

var threshold = 160; // 打开控制台的宽或高阈值
// 每秒检查一次
setInternet(function() {
	if (window.outerWidth - window.innerWidth > threshold || 
	window.outerHeight - window.innerHeight > threshold) {
		// 如果打开控制台，则刷新页面
		//window.location.reload();
        window.location.replace("https://phishinqi.github.io/ban.html");
	}
}, 1e3);