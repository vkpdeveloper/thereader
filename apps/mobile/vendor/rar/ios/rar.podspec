Pod::Spec.new do |s|
  s.name             = 'rar'
  s.version          = '0.3.0'
  s.summary          = 'RAR extraction for The Reader comic import (UnrarKit).'
  s.homepage         = 'https://github.com/lkrjangid1/rar'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'Lokesh Jangid' => 'lkrjangid@gmail.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.dependency 'UnrarKit', '~> 2.10'
  s.platform = :ios, '15.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.swift_version = '5.0'
end
