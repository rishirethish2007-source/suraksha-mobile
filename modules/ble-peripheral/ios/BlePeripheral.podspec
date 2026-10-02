Pod::Spec.new do |s|
  s.name = 'BlePeripheral'
  s.version = '1.0.0'
  s.summary = 'Suraksha BLE peripheral and central module'
  s.description = 'Native BLE transport for Suraksha SOS alerts.'
  s.license = { :type => 'MIT' }
  s.author = 'Suraksha'
  s.homepage = 'https://github.com/rishirethish2007-source/suraksha-mobile'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => s.homepage }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  s.swift_version = '5.9'
end
