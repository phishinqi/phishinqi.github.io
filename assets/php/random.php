<?php
$seed = time();
$num = rand(0,17);
//拼接图片地址
$picpath = "https://gcore.jsdelivr.net/gh/phishinqi/randpic/img/".$num.".jpg";
//重定位到图片
die(header("Location: $picpath"));
?>
